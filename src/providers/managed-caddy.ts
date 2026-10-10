import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RigError, boundedEvidence, lastOutputLine } from "../domain/errors";
import {
  caddyfileSites,
  customFileHeader,
  customFileProblems,
  generationFiles,
  normalizeToken,
  protectedGlobalOptions,
  proxyPaths,
  redactSecrets,
  renderMainCaddyfile,
  type ProxyPaths,
} from "../domain/managed-proxy";
import {
  adaptedSiteAddresses,
  issuerCas,
  protectedDifferences,
} from "../domain/caddy-config";
import type { ProxySettings } from "../config/proxy-schema";
import type { CommandRunner } from "./contracts";
import {
  editRouteFile,
  ownedBlock,
  rerenderOwnedBlocks,
  routeFileHostnames,
  withheldPaths,
  type RouteCheckpoint,
  type RouteRequest,
  type Router,
} from "./route-file";

/** How the job that runs Rig's Caddy stands, as its process manager reports it. `stopped` is confirmed: the job is not loaded,
 * has no process, or its recorded process is gone. `unknown` means the manager could not tell. */
export type CaddyJobState = "running" | "stopped" | "unknown";
/** The process manager side of Rig's Caddy: launchd or a detached process. */
export interface CaddyJob {
  state(): Promise<CaddyJobState>;
  /** Ends the running Caddy so its manager starts it again from the current generation and binary. Resolves once the new
   * process answers on its admin socket; fails at the deadline. */
  restart(): Promise<void>;
}
/** Caddy's admin API on its Unix socket. */
export interface CaddyAdmin {
  /** Whether the socket answers within a short deadline. */
  reachable(): Promise<boolean>;
  /** The config Caddy runs, as GET /config/ returns it; undefined when the socket does not answer. */
  config(): Promise<unknown>;
}
/** What one generation was built from, recorded beside it. */
interface GenerationMetadata {
  id: string;
  /** The CA its main file names: a change of CA restarts Caddy, since a reload keeps cached certificates. */
  ca: string;
  /** Digest of the settings it was rendered from, so an unchanged republish builds nothing. */
  settings: string;
  /** The site addresses its custom file serves, read from `caddy adapt` of that file alone: the one inventory reporting,
   * verify, conflicts and wildcard planning use. */
  customSites: string[];
  createdAt: string;
}
/** The custom files of a generation: the owner's sites and snippets, and global options. */
export interface CustomFiles {
  readonly sites: string;
  readonly global: string;
}
/** Why a publication was made, which decides the failure codes: a route change, an apply of the custom files, or a republish
 * after a settings change. */
type PublicationKind = "route" | "custom" | "settings";
export interface ManagedCaddyOptions {
  readonly root: string;
  /** The `proxy` settings as Host config says now; read at every publication. */
  readonly settings: () => Promise<ProxySettings>;
  /** Runs Rig's Caddy binary for validate and reload. */
  readonly run: CommandRunner;
  readonly job: CaddyJob;
  readonly admin: CaddyAdmin;
  /** A new generation id; ids sort by age. */
  readonly generationId?: () => string;
  readonly now?: () => Date;
}
/** Rig's own Caddy (ADR 0014): routes and custom files are published as immutable generations behind one atomic switch,
 * each validated by Caddy before it is switched to, and reloaded or, when the CA changed, restarted. Every change runs in one
 * queue. */
export interface ManagedCaddy {
  readonly router: Router;
  /** Rewrites every owned route block with the current `site` lines and builds a generation from the current settings,
   * unless the current generation already says exactly that. */
  republish(): Promise<{ published: boolean }>;
  /** Builds a generation with the custom files as they are on disk; they become the accepted ones once it serves. */
  applyCustom(): Promise<void>;
  readonly paths: ProxyPaths;
}
export function createManagedCaddy(options: ManagedCaddyOptions): ManagedCaddy {
  const paths = proxyPaths(options.root);
  const now = options.now ?? (() => new Date());
  const generationId =
    options.generationId ??
    (() =>
      `${Date.now().toString().padStart(14, "0")}-${randomUUID().slice(0, 8)}`);
  let pending: Promise<unknown> = Promise.resolve();
  function queued<T>(work: () => Promise<T>): Promise<T> {
    const operation = pending.catch(() => {}).then(work);
    pending = operation;
    return operation;
  }

  async function readText(path: string): Promise<string | undefined> {
    return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  }
  async function currentGeneration(): Promise<string | undefined> {
    const target = await readlink(paths.current).catch(() => undefined);
    if (!target) return undefined;
    const directory = target.startsWith("/")
      ? target
      : join(dirname(paths.current), target);
    return (await stat(generationFiles(directory).main).catch(() => undefined))
      ? directory
      : undefined;
  }
  async function metadataOf(
    directory: string | undefined,
  ): Promise<GenerationMetadata | undefined> {
    if (!directory) return undefined;
    const text = await readText(generationFiles(directory).metadata);
    try {
      return text ? (JSON.parse(text) as GenerationMetadata) : undefined;
    } catch {
      return undefined;
    }
  }
  /** The custom files on disk, created with their header when missing. */
  async function diskCustom(): Promise<CustomFiles> {
    await mkdir(dirname(paths.custom), { recursive: true });
    for (const [path, kind] of [
      [paths.custom, "sites"],
      [paths.customGlobal, "global"],
    ] as const)
      await writeFile(path, customFileHeader(kind), { flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    return {
      sites: (await readText(paths.custom)) ?? "",
      global: (await readText(paths.customGlobal)) ?? "",
    };
  }
  /** The accepted custom files: the current generation's copies. Before the first generation nothing is accepted yet, so
   * they are empty; the owner's files, created if missing, take effect through an apply. */
  async function acceptedCustom(): Promise<CustomFiles> {
    const current = await currentGeneration();
    if (!current) {
      await diskCustom();
      return {
        sites: customFileHeader("sites"),
        global: customFileHeader("global"),
      };
    }
    const files = generationFiles(current);
    return {
      sites: (await readText(files.custom)) ?? "",
      global: (await readText(files.customGlobal)) ?? "",
    };
  }
  async function token(settings: ProxySettings): Promise<string | undefined> {
    if (settings.tls.ca === "internal") return undefined;
    const text = await readText(paths.token).catch(() => undefined);
    if (text === undefined)
      throw new RigError(
        "PROXY_TOKEN",
        `No DNS API token is stored at ${paths.token}.`,
        "Pipe a Cloudflare API token with Zone:DNS:Edit on your zone to rig proxy token.",
        { path: paths.token },
      );
    return normalizeToken(text);
  }
  async function binary(): Promise<string> {
    if (!(await stat(paths.binary).catch(() => undefined)))
      throw new RigError(
        "PROXY_BINARY",
        `Rig's Caddy is not installed at ${paths.binary}.`,
        "Run rigd install, which copies and checks the Caddy that proxy.caddy names.",
        { path: paths.binary },
      );
    return paths.binary;
  }
  async function switchTo(directory: string | undefined): Promise<void> {
    if (!directory) {
      await rm(paths.current, { force: true });
      return;
    }
    const temporary = `${paths.current}.${randomUUID()}.tmp`;
    await symlink(join("generations", basename(directory)), temporary);
    await rename(temporary, paths.current);
  }
  async function prune(keep: readonly (string | undefined)[]): Promise<void> {
    const names = (await readdir(paths.generations).catch(() => [])).sort();
    const kept = new Set(keep.filter(Boolean).map((path) => basename(path!)));
    const complete = names.filter((name) => !/\.(tmp|rejected)$/.test(name));
    for (const name of complete.slice(0, -5))
      if (!kept.has(name))
        await rm(join(paths.generations, name), {
          recursive: true,
          force: true,
        });
    for (const name of names
      .filter((name) => name.endsWith(".rejected"))
      .slice(0, -3))
      await rm(join(paths.generations, name), { recursive: true, force: true });
    for (const name of names.filter((name) => name.endsWith(".tmp")))
      await rm(join(paths.generations, name), { recursive: true, force: true });
  }
  /** Runs Rig's Caddy; output it keeps or shows has the token redacted. */
  async function caddy(
    command: readonly string[],
    secret: string | undefined,
  ): Promise<{ exitCode: number; stderr: string }> {
    const result = await options.run({ command }).catch((error: unknown) => ({
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }));
    return {
      exitCode: result.exitCode,
      stderr: redactSecrets(result.stderr, secret ? [secret] : []),
    };
  }

  /** Refuses custom files that would read other files or set what Rig sets. */
  function checkCustom(custom: CustomFiles): void {
    const taken = protectedGlobalOptions(custom.global);
    if (taken.length)
      throw new RigError(
        "PROXY_CUSTOM_INVALID",
        `${paths.customGlobal}:${taken[0]!.line} sets ${taken[0]!.option}, which Rig sets itself.`,
        `Delete ${taken.map((entry) => `${entry.option} (line ${entry.line})`).join(", ")} from ${paths.customGlobal} and run rig proxy reload again; ports, certificates and the CA are set under proxy in Host config. Nothing changed.`,
        { options: taken },
      );
    const problems = customFileProblems(custom, options.root);
    if (problems.length) {
      const where = (problem: (typeof problems)[number]) =>
        `${problem.file === "sites" ? paths.custom : paths.customGlobal}:${problem.line}`;
      throw new RigError(
        "PROXY_CUSTOM_INVALID",
        `${where(problems[0]!)} ${problems[0]!.problem}; custom files may not read other files.`,
        `Inline the snippet into custom.caddy (define it there as (name) { ... } and import it by name), and keep certificate files under the Rig root. Then run rig proxy reload again. Nothing changed. Also: ${problems.map((problem) => `${where(problem)} ${problem.problem}`).join("; ")}.`,
        { problems },
      );
    }
  }
  /** `caddy adapt` of one file with Rig's binary, as JSON; a failure carries Caddy's last line, redacted. */
  async function adapt(
    executable: string,
    file: string,
    secret: string | undefined,
  ): Promise<{ config?: unknown; reason?: string }> {
    const result = await options
      .run({
        command: [
          executable,
          "adapt",
          "--config",
          file,
          "--adapter",
          "caddyfile",
        ],
      })
      .catch((error: unknown) => ({
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
    if (result.exitCode !== 0)
      return {
        reason:
          lastOutputLine(
            redactSecrets(result.stderr, secret ? [secret] : []),
          ) ?? "caddy adapt failed",
      };
    try {
      return { config: JSON.parse(result.stdout || "{}") };
    } catch {
      return { reason: "caddy adapt printed no JSON" };
    }
  }
  /** The adapted JSON a generation was validated as; undefined for one built before generations recorded it. */
  async function adaptedOf(directory: string): Promise<unknown> {
    const text = await readText(generationFiles(directory).adapted);
    try {
      return text === undefined ? undefined : JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** Builds, validates and switches to a generation of `routes` and `custom`, then makes Caddy serve it, and confirms that it
   * does. A failure at any step leaves the previous generation current and served. */
  async function publish(
    routes: string,
    custom: CustomFiles,
    kind: PublicationKind,
  ): Promise<void> {
    const settings = await options.settings();
    checkCustom(custom);
    const secret = await token(settings);
    const executable = await binary();
    const previous = await currentGeneration();
    const id = generationId();
    const directory = join(paths.generations, id);
    const files = generationFiles(directory);
    const building = `${directory}.tmp`;
    const staged = generationFiles(building);
    await mkdir(building, { recursive: true });
    await mkdir(paths.data, { recursive: true, mode: 0o700 });
    await writeFile(staged.routes, routes);
    await writeFile(staged.custom, custom.sites);
    await writeFile(staged.customGlobal, custom.global);
    const rejectedAs = async (reason: string | undefined, stderr: string) => {
      const rejected = `${directory}.rejected`;
      await rename(
        (await stat(directory).catch(() => undefined)) ? directory : building,
        rejected,
      );
      await prune([previous]).catch(() => {});
      const details = {
        stderr,
        rejectedPath: rejected,
        evidence: boundedEvidence(reason ?? ""),
      };
      if (kind === "custom")
        return new RigError(
          "PROXY_CUSTOM_INVALID",
          `Caddy rejected the custom files${reason ? `: ${reason}` : "."}`,
          `Nothing changed; Rig's routes keep serving. Fix ${paths.custom} or ${paths.customGlobal} and run rig proxy reload again. What Caddy saw is kept in ${rejected}.`,
          details,
        );
      return new RigError(
        kind === "route" ? "ROUTE_VALIDATE" : "PROXY_CONFIG_INVALID",
        `Caddy rejected the ${kind === "route" ? "updated routes" : "proxy configuration"}${reason ? `: ${reason}` : "."}`,
        `Nothing changed. What Caddy saw is kept in ${rejected}; fix the ${kind === "route" ? "route configuration" : "proxy section of Host config"} and retry.`,
        details,
      );
    };
    // The custom sites, read from Caddy's own parse of the custom file alone, are the one inventory everything uses.
    const inventory = await adapt(executable, staged.custom, secret);
    if (inventory.config === undefined)
      throw await rejectedAs(inventory.reason, inventory.reason ?? "");
    const customSites = adaptedSiteAddresses(inventory.config);
    const metadata: GenerationMetadata = {
      id,
      ca: settings.tls.ca,
      settings: settingsDigest(settings),
      customSites,
      createdAt: now().toISOString(),
    };
    await writeFile(
      staged.main,
      renderMainCaddyfile({
        settings,
        paths,
        generation: directory,
        hostnames: routeFileHostnames(routes),
        customSites,
      }),
    );
    await writeFile(staged.metadata, JSON.stringify(metadata, null, 2) + "\n");
    await rename(building, directory);

    const validation = await caddy(
      [
        executable,
        "validate",
        "--config",
        files.main,
        "--adapter",
        "caddyfile",
      ],
      secret,
    );
    if (validation.exitCode !== 0)
      throw await rejectedAs(
        lastOutputLine(validation.stderr),
        validation.stderr,
      );
    // What Caddy will run, kept beside the generation: activation is confirmed against it, and the owner's files may not
    // move what Rig sets.
    const adapted = await adapt(executable, files.main, secret);
    if (adapted.config === undefined)
      throw await rejectedAs(adapted.reason, adapted.reason ?? "");
    const moved = protectedDifferences(adapted.config, {
      admin: `unix/${paths.socket}|0600`,
      storage: paths.data,
      httpPort: settings.ports.http,
      httpsPort: settings.ports.https,
    });
    if (moved.length)
      throw await rejectedAs(
        `the configuration changes ${moved.join(", ")}, which Rig sets itself`,
        "",
      );
    await writeFile(files.adapted, JSON.stringify(adapted.config) + "\n");
    await switchTo(directory);
    try {
      await activate(directory, executable, secret, kind);
    } catch (error) {
      await switchTo(previous);
      // Put back what was served, and say whether that worked: the error alone cannot tell.
      const restored = previous
        ? await activate(previous, executable, secret, kind).then(
            () => true,
            () => false,
          )
        : true;
      if (error instanceof RigError && !restored)
        throw new RigError(
          error.code,
          error.message.replace(
            /; the previous configuration was restored\.$/,
            ".",
          ),
          `${error.hint} Serving the previous configuration again failed too, so inspect Caddy (rig doctor) before retrying.`,
          { ...error.details, rollbackReloaded: false },
        );
      throw error;
    }
    // The change is served; tidying old generations must not turn it into a failure.
    await prune([directory, previous]).catch(() => {});
  }
  /** Makes Caddy serve generation `directory` and confirms it from what Caddy reports it runs. A Caddy confirmed stopped
   * reads the current generation when it starts. One that runs but cannot be reached may still serve another generation,
   * so that is a failure, never a success. Caddy already running it needs nothing; a different CA needs a restart, since a
   * reload keeps the certificates Caddy has cached; anything else a reload. */
  async function activate(
    directory: string,
    executable: string,
    secret: string | undefined,
    kind: PublicationKind,
  ): Promise<void> {
    const expected = await adaptedOf(directory);
    const loaded = await options.admin.config();
    if (loaded === undefined) {
      const state = await options.job.state();
      if (state === "stopped") return;
      throw new RigError(
        "PROXY_UNREACHABLE",
        state === "running"
          ? "Rig's Caddy is running but its admin socket does not answer, so it may still serve another configuration."
          : "Rig's Caddy could not be reached and its job state is unknown, so it may still serve another configuration.",
        `Nothing was changed. Run rig doctor; if Caddy is stuck, restart its job (rigd install), then retry.`,
        { socket: paths.socket, state },
      );
    }
    if (expected !== undefined && Bun.deepEquals(loaded, expected)) return;
    // Only certificates from another CA must go; a Caddy with no issuer yet holds none.
    const loadedCas = issuerCas(loaded);
    if (
      expected !== undefined &&
      loadedCas.length > 0 &&
      loadedCas.join(" ") !== issuerCas(expected).join(" ")
    )
      await options.job.restart();
    else {
      const reload = await caddy(
        [
          executable,
          "reload",
          "--config",
          generationFiles(directory).main,
          "--adapter",
          "caddyfile",
        ],
        secret,
      );
      if (reload.exitCode !== 0) {
        const reason = lastOutputLine(reload.stderr);
        throw new RigError(
          kind === "route" ? "ROUTE_RELOAD" : "PROXY_RELOAD",
          `Caddy could not reload${reason ? ` (${reason})` : ""}; the previous configuration was restored.`,
          "Inspect Caddy's log and retry.",
          { stderr: reload.stderr, evidence: boundedEvidence(reason ?? "") },
        );
      }
    }
    if (expected === undefined) return;
    const serving = await options.admin.config();
    if (!Bun.deepEquals(serving, expected))
      throw new RigError(
        "PROXY_ACTIVATION",
        `Caddy answered, but does not serve generation ${basename(directory)}; the previous configuration was restored.`,
        "Run rig doctor and read Caddy's log before retrying.",
        { generation: basename(directory) },
      );
  }
  /** Confirms Caddy serves the current generation, making it do so when it does not: after a crash between switching and
   * activating, or a reload that never happened. Every change runs this first, so nothing touches an upstream while what
   * Caddy serves is unknown. */
  async function reconcile(kind: PublicationKind): Promise<void> {
    const current = await currentGeneration();
    if (!current) return;
    const settings = await options.settings();
    const secret = await token(settings).catch(() => undefined);
    await activate(current, await binary(), secret, kind);
  }

  /** Writes the route file whole, through a symlink and keeping its mode, as the external router does: the emergency
   * rollback hands this same file to the old router Caddy, which must still find and read it. */
  async function writeRoutes(text: string, before: string): Promise<void> {
    await mkdir(dirname(paths.routes), { recursive: true });
    const file = await realpath(paths.routes).catch(() => paths.routes);
    const mode = (await stat(file).catch(() => undefined))?.mode ?? 0o600;
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(`${file}.rig-backup`, before, { mode });
    await writeFile(temporary, text, { mode });
    await chmod(temporary, mode & 0o777);
    await rename(temporary, file);
  }
  /** Publishes `custom` with every owned block rendered again for the current `site` lines; the route file is put back when
   * the publication fails. Resolves whether anything was published. */
  async function republishWith(
    custom: CustomFiles,
    kind: "custom" | "settings",
  ): Promise<void> {
    const settings = await options.settings();
    const before = (await readText(paths.routes)) ?? "";
    const routes = rerenderOwnedBlocks(before, settings.site);
    if (routes !== before) await writeRoutes(routes, before);
    try {
      await publish(routes, custom, kind);
    } catch (error) {
      if (routes !== before) await writeRoutes(before, routes);
      throw error;
    }
  }
  async function change(
    key: string,
    route?: RouteRequest,
    restoration?: { saved: RouteCheckpoint; expected: RouteCheckpoint },
  ): Promise<void> {
    // Nothing changes while what Caddy serves is unknown: a withdrawal must be served before its upstream may stop.
    await reconcile("route");
    const before = (await readText(paths.routes)) ?? "";
    const settings = await options.settings();
    const custom = await acceptedCustom();
    const current = await currentGeneration();
    const edit = editRouteFile({
      before,
      key,
      ...(route ? { route } : {}),
      ...(restoration ? { restoration } : {}),
      siteConfig: settings.site,
      reserved: {
        sites:
          (await metadataOf(current))?.customSites ??
          caddyfileSites(custom.sites),
        owner: paths.custom,
      },
    });
    const after = edit?.after ?? before;
    // Done only when Caddy serves exactly this, which reconcile just confirmed for the current generation. A route file
    // ahead of it (a crash between writing it and publishing) is published here, even when this change adds nothing.
    const served = current
      ? await readText(generationFiles(current).routes)
      : undefined;
    if (after === served) return;
    if (after !== before) await writeRoutes(after, before);
    try {
      await publish(after, custom, "route");
    } catch (error) {
      if (after !== before) await writeRoutes(before, after);
      throw error;
    }
  }
  /** Read in the queue: a change writes the route file before it publishes and puts it back when publishing fails, so a read
   * beside it could see a block that was never served. */
  function readOwned(key: string): Promise<string | null> {
    return queued(async () =>
      ownedBlock((await readText(paths.routes)) ?? "", key),
    );
  }
  return {
    paths,
    router: {
      apply: (route) => queued(() => change(route.key, route)),
      remove: (key) => queued(() => change(key)),
      withheld: async (key) => withheldPaths((await readOwned(key)) ?? ""),
      checkpoint: async (key) => ({ key, value: await readOwned(key) }),
      restore: (saved, expected) =>
        queued(() => change(saved.key, undefined, { saved, expected })),
    },
    republish: () =>
      queued(async () => {
        const settings = await options.settings();
        const before = (await readText(paths.routes)) ?? "";
        const current = await currentGeneration();
        if (
          current &&
          rerenderOwnedBlocks(before, settings.site) === before &&
          (await metadataOf(current))?.settings === settingsDigest(settings) &&
          (await readText(generationFiles(current).routes)) === before &&
          (await adaptedOf(current)) !== undefined
        ) {
          // The files say it; Caddy must too. A crash after the switch leaves Caddy on the previous generation, a CA change
          // included, until this makes it serve the current one.
          await reconcile("settings");
          return { published: false };
        }
        await republishWith(await acceptedCustom(), "settings");
        return { published: true };
      }),
    // `rig proxy reload` applies the proxy settings too, so the owned blocks take the current site lines.
    applyCustom: () =>
      queued(async () => republishWith(await diskCustom(), "custom")),
  };
}
/** A digest of the settings a generation is rendered from. */
function settingsDigest(settings: ProxySettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}
