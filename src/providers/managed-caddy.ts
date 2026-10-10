import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  readlink,
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
  generationFiles,
  normalizeToken,
  proxyPaths,
  redactSecrets,
  renderMainCaddyfile,
  type ProxyPaths,
} from "../domain/managed-proxy";
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
}
/** What one generation was built from, recorded beside it. */
interface GenerationMetadata {
  id: string;
  /** The CA its main file names: a change of CA restarts Caddy, since a reload keeps cached certificates. */
  ca: string;
  /** Digest of the settings it was rendered from, so an unchanged republish builds nothing. */
  settings: string;
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
  /** The accepted custom files: the current generation's copies, or the files on disk before the first generation. */
  async function acceptedCustom(): Promise<CustomFiles> {
    const current = await currentGeneration();
    if (!current) return diskCustom();
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

  /** Builds, validates and switches to a generation of `routes` and `custom`, then makes Caddy serve it. A failure at any step
   * leaves the previous generation current and served. */
  async function publish(
    routes: string,
    custom: CustomFiles,
    kind: PublicationKind,
  ): Promise<void> {
    const settings = await options.settings();
    const secret = await token(settings);
    const executable = await binary();
    const previous = await currentGeneration();
    const previousMetadata = await metadataOf(previous);
    const id = generationId();
    const directory = join(paths.generations, id);
    const files = generationFiles(directory);
    const building = `${directory}.tmp`;
    const staged = generationFiles(building);
    await mkdir(building, { recursive: true });
    await mkdir(paths.data, { recursive: true, mode: 0o700 });
    const metadata: GenerationMetadata = {
      id,
      ca: settings.tls.ca,
      settings: settingsDigest(settings),
      createdAt: now().toISOString(),
    };
    await writeFile(staged.routes, routes);
    await writeFile(staged.custom, custom.sites);
    await writeFile(staged.customGlobal, custom.global);
    await writeFile(
      staged.main,
      renderMainCaddyfile({
        settings,
        paths,
        generation: directory,
        hostnames: routeFileHostnames(routes),
        customSites: caddyfileSites(custom.sites),
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
    if (validation.exitCode !== 0) {
      const rejected = `${directory}.rejected`;
      await rename(directory, rejected);
      await prune([previous]);
      const reason = lastOutputLine(validation.stderr);
      const details = {
        stderr: validation.stderr,
        rejectedPath: rejected,
        evidence: boundedEvidence(reason ?? ""),
      };
      if (kind === "custom")
        throw new RigError(
          "PROXY_CUSTOM_INVALID",
          `Caddy rejected the custom files${reason ? `: ${reason}` : "."}`,
          `Nothing changed; Rig's routes keep serving. Fix ${paths.custom} or ${paths.customGlobal} and run rig proxy reload again. What Caddy saw is kept in ${rejected}.`,
          details,
        );
      throw new RigError(
        kind === "route" ? "ROUTE_VALIDATE" : "PROXY_CONFIG_INVALID",
        `Caddy rejected the ${kind === "route" ? "updated routes" : "proxy configuration"}${reason ? `: ${reason}` : "."}`,
        `Nothing changed. What Caddy saw is kept in ${rejected}; fix the ${kind === "route" ? "route configuration" : "proxy section of Host config"} and retry.`,
        details,
      );
    }
    await switchTo(directory);
    try {
      await activate(
        executable,
        files.main,
        secret,
        previousMetadata?.ca !== undefined &&
          previousMetadata.ca !== settings.tls.ca,
        kind,
      );
    } catch (error) {
      await switchTo(previous);
      if (previous)
        await caddy(
          [
            executable,
            "reload",
            "--config",
            generationFiles(previous).main,
            "--adapter",
            "caddyfile",
          ],
          secret,
        );
      throw error;
    }
    await prune([directory, previous]);
  }
  /** Makes Caddy serve the generation just switched to. A Caddy confirmed stopped reads it when it starts; one that runs but
   * cannot be reached may still serve the previous generation, so that is a failure, never a success. */
  async function activate(
    executable: string,
    main: string,
    secret: string | undefined,
    caChanged: boolean,
    kind: PublicationKind,
  ): Promise<void> {
    if (!(await options.admin.reachable())) {
      const state = await options.job.state();
      if (state === "stopped") return;
      throw new RigError(
        "PROXY_UNREACHABLE",
        state === "running"
          ? "Rig's Caddy is running but its admin socket does not answer, so it may still serve the previous configuration."
          : "Rig's Caddy could not be reached and its job state is unknown, so it may still serve the previous configuration.",
        `Nothing was changed. Run rig doctor; if Caddy is stuck, restart its job (rigd install), then retry.`,
        { socket: paths.socket, state },
      );
    }
    // A reload keeps Caddy's certificate cache, so certificates from the previous CA would keep being served.
    if (caChanged) {
      await options.job.restart();
      return;
    }
    const reload = await caddy(
      [executable, "reload", "--config", main, "--adapter", "caddyfile"],
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

  async function writeRoutes(text: string, before: string): Promise<void> {
    await mkdir(dirname(paths.routes), { recursive: true });
    const temporary = `${paths.routes}.${randomUUID()}.tmp`;
    await writeFile(`${paths.routes}.rig-backup`, before, { mode: 0o600 });
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, paths.routes);
  }
  async function change(
    key: string,
    route?: RouteRequest,
    restoration?: { saved: RouteCheckpoint; expected: RouteCheckpoint },
  ): Promise<void> {
    const before = (await readText(paths.routes)) ?? "";
    const settings = await options.settings();
    const custom = await acceptedCustom();
    const edit = editRouteFile({
      before,
      key,
      ...(route ? { route } : {}),
      ...(restoration ? { restoration } : {}),
      siteConfig: settings.site,
      reserved: { sites: caddyfileSites(custom.sites), owner: paths.custom },
    });
    if (!edit) return;
    const current = await currentGeneration();
    const served = current
      ? await readText(generationFiles(current).routes)
      : undefined;
    if (edit.after === before && served === before && !edit.withdrawing) return;
    await writeRoutes(edit.after, before);
    try {
      await publish(edit.after, custom, "route");
    } catch (error) {
      await writeRoutes(before, edit.after);
      throw error;
    }
  }
  async function readOwned(key: string): Promise<string | null> {
    await pending.catch(() => {});
    return ownedBlock((await readText(paths.routes)) ?? "", key);
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
        const routes = rerenderOwnedBlocks(before, settings.site);
        const custom = await acceptedCustom();
        const current = await currentGeneration();
        const metadata = await metadataOf(current);
        if (
          current &&
          routes === before &&
          metadata?.settings === settingsDigest(settings) &&
          (await readText(generationFiles(current).routes)) === routes
        )
          return { published: false };
        if (routes !== before) await writeRoutes(routes, before);
        try {
          await publish(routes, custom, "settings");
        } catch (error) {
          if (routes !== before) await writeRoutes(before, routes);
          throw error;
        }
        return { published: true };
      }),
    applyCustom: () =>
      queued(async () => {
        const routes = (await readText(paths.routes)) ?? "";
        await publish(routes, await diskCustom(), "custom");
      }),
  };
}
/** A digest of the settings a generation is rendered from. */
function settingsDigest(settings: ProxySettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}
