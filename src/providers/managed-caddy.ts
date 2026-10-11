import { randomUUID } from "node:crypto";
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
  bareHostname,
  generationFiles,
  hostRoutes,
  normalizeToken,
  proxyPaths,
  redactSecrets,
  renderMainCaddyfile,
  settingsDigest,
  type HostRoute,
  type ProxyPaths,
} from "../domain/managed-proxy";
import {
  issuancePolicies,
  issuerCas,
  protectedDifferences,
  withDownPages,
} from "../domain/caddy-config";
import {
  proxySettingsSchema,
  type ProxySettings,
} from "../config/proxy-schema";
import type { CommandRunner } from "./contracts";
import {
  editRouteFile,
  ownedBlock,
  parseOwnedSites,
  assertSingleOwners,
  canonicalRouteFile,
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
  /** The proxy settings it was rendered from: once it serves, the last accepted ones, which every route change and recovery
   * publishes with until a republish of newer Host config is accepted. */
  proxy?: ProxySettings;
  /** The owner's own routes it serves, from `proxy.routes`: what reporting and verify list beside Rig's. */
  customRoutes: HostRoute[];
  createdAt: string;
}
/** Why a publication was made, which decides the failure codes: a route change, or a republish of the current settings. */
type PublicationKind = "route" | "settings";
/** Failures that mean Host config itself was refused, not that Caddy could not be reached: recorded as pending, while Rig's
 * routes go on with the last accepted settings. */
const SETTINGS_REFUSALS = new Set([
  "PROXY_CONFIG_INVALID",
  "ROUTE_CONFLICT",
  "PROXY_PATH",
  "PROXY_TOKEN",
]);
/** Host config Rig refused, recorded so `rig proxy` and doctor can say why it is not served. */
export interface RejectedSettings {
  /** Digest of the refused settings: the record holds only while Host config still says them. */
  readonly settings: string;
  readonly code: string;
  readonly reason: string;
  readonly at: string;
}
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
  /** How long a Caddy whose job runs may take to answer on its socket before a change fails; 10 s by default. */
  readonly reachableWaitMs?: number;
  readonly now?: () => Date;
}
/** Rig's own Caddy (ADR 0014): Rig's routes and the owner's `proxy.routes` are published as immutable generations behind one atomic switch,
 * each validated by Caddy before it is switched to, and reloaded or, when the CA changed, restarted. Every change runs in one
 * queue. */
export interface ManagedCaddy {
  readonly router: Router;
  /** Builds a generation from the proxy section of Host config as it is now, `proxy.routes` included, unless the current
   * generation already says exactly that (`rig proxy reload`, rigd's start). Settings Rig refuses are recorded as pending
   * with the reason and the error is thrown; Caddy keeps serving the last accepted ones, and a route file ahead of what it
   * serves is still published with them. */
  republish(): Promise<{ published: boolean }>;
  readonly paths: ProxyPaths;
}
export function createManagedCaddy(options: ManagedCaddyOptions): ManagedCaddy {
  const paths = proxyPaths(options.root);
  const now = options.now ?? (() => new Date());
  const reachableWaitMs = options.reachableWaitMs ?? 10_000;
  const generationId =
    options.generationId ??
    (() =>
      `${Date.now().toString().padStart(14, "0")}-${randomUUID().slice(0, 8)}`);
  let pending: Promise<unknown> = Promise.resolve();
  /** Hostnames a deploy checked and is about to publish, by route key, held in this process only. */
  const reservations = new Map<string, string[]>();
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
  /** The settings the current generation was accepted with; Host config as it is before the first generation. A generation
   * that recorded none (only unreleased builds made such) is no last-good either: there is no migration, by decision. */
  async function acceptedSettings(): Promise<ProxySettings> {
    const recorded = (await metadataOf(await currentGeneration()))?.proxy;
    const parsed = proxySettingsSchema.safeParse(recorded);
    return parsed.success ? parsed.data : await options.settings();
  }
  async function recordRejection(
    settings: ProxySettings,
    error: RigError,
  ): Promise<void> {
    const record: RejectedSettings = {
      settings: settingsDigest(settings),
      code: error.code,
      reason: error.message,
      at: now().toISOString(),
    };
    await mkdir(paths.caddy, { recursive: true });
    await writeFile(paths.rejectedSettings, JSON.stringify(record) + "\n");
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

  /** Builds, validates and switches to a generation of `routes` and `settings`, then makes Caddy serve it, and confirms that
   * it does. A failure at any step leaves the previous generation current and served. */
  async function publish(
    routes: string,
    kind: PublicationKind,
    settings: ProxySettings,
  ): Promise<void> {
    // Only what Rig renders from its owned blocks is ever published, whatever a caller passed.
    routes = canonicalRouteFile(routes).text;
    const rigHosts = routeFileHostnames(routes);
    const customRoutes = hostRoutes(settings);
    // The invariant, at the one point every publication passes (apply, restore, a recovery stop, a republish, a reload): a
    // hostname has one owner, a Target's block or a proxy.routes entry. One name is one site to a client, whatever scheme or
    // port it is written with, and Caddy would merge two blocks for it, so they are compared bare.
    assertOwners(routes, settings);
    // Reservations protect deploys in flight, on top of the invariant: an owner route may not claim what one is about to
    // publish or restore.
    const reserved = customRoutes.find((route) =>
      [...reservations.values()].some((hosts) =>
        hosts.includes(route.hostname),
      ),
    );
    if (reserved)
      throw new RigError(
        "ROUTE_CONFLICT",
        `proxy.routes in Host config names ${reserved.hostname}, which a deploy is about to publish.`,
        `Wait for the deploy to finish, then remove ${reserved.hostname} from proxy.routes or take it off the Target. Nothing changed.`,
        {
          hostname: reserved.hostname,
          owners: ["a deploy in progress", "proxy.routes in Host config"],
        },
      );
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
    const rejectedAs = async (
      reason: string | undefined,
      stderr: string,
      by: "caddy" | "rig" = "caddy",
    ) => {
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
      const verb = by === "caddy" ? "Caddy rejected" : "Rig refused";
      return new RigError(
        kind === "route" ? "ROUTE_VALIDATE" : "PROXY_CONFIG_INVALID",
        `${verb} the ${kind === "route" ? "updated routes" : "proxy configuration"}${reason ? `: ${reason}` : "."}`,
        `Nothing changed. What Caddy saw is kept in ${rejected}; fix the ${kind === "route" ? "route configuration" : "proxy section of Host config"} and retry.`,
        details,
      );
    };
    const metadata: GenerationMetadata = {
      id,
      ca: settings.tls.ca,
      settings: settingsDigest(settings),
      proxy: settings,
      customRoutes,
      createdAt: now().toISOString(),
    };
    await writeFile(
      staged.main,
      renderMainCaddyfile({
        settings,
        paths,
        generation: directory,
        hostnames: rigHosts,
      }),
    );
    await writeFile(staged.metadata, JSON.stringify(metadata, null, 2) + "\n");
    await rename(building, directory);

    // What Caddy will run, kept beside the generation: activation is confirmed against it. Every value in the Caddyfile went
    // through caddyValue, so it holds nothing but Rig's own directives; Rig adds its page for errors Caddy itself raises.
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
        "rig",
      );
    await writeFile(
      files.adapted,
      JSON.stringify(withDownPages(adapted.config)) + "\n",
    );
    // Only the accepted, frozen JSON is provisioned, by validation, and it is exactly what Caddy will load.
    const validation = await caddy(
      [executable, "validate", "--config", files.adapted],
      secret,
    );
    if (validation.exitCode !== 0)
      throw await rejectedAs(
        lastOutputLine(validation.stderr),
        validation.stderr,
      );
    await switchTo(directory);
    try {
      await activate(directory, executable, secret, kind, "publish");
    } catch (error) {
      await switchTo(previous);
      // Put back what was served, and say whether that worked: the error alone cannot tell.
      const restored = previous
        ? await activate(previous, executable, secret, kind, "reconcile").then(
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
   * so that is a failure, never a success, after a bounded wait for a Caddy that is still opening its socket. Caddy already
   * running it needs nothing; a different CA needs a restart, since a reload keeps the certificates Caddy has cached;
   * anything else a reload of the generation's adapted JSON, which never re-reads a Caddyfile or an import. `restoring`
   * says what a failure means to the caller: a publication rolls back, reconciling has nothing to roll back to. */
  async function activate(
    directory: string,
    executable: string,
    secret: string | undefined,
    kind: PublicationKind,
    during: "publish" | "reconcile",
  ): Promise<void> {
    const outcome =
      during === "publish"
        ? "; the previous configuration was restored."
        : "; Caddy still serves another configuration, so nothing was changed.";
    const expected = await adaptedOf(directory);
    let loaded = await options.admin.config();
    if (loaded === undefined) {
      let state = await options.job.state();
      if (state === "stopped") return;
      // At boot launchd shows the job running before Caddy has opened its socket.
      for (
        const deadline = Date.now() + reachableWaitMs;
        loaded === undefined && state !== "stopped" && Date.now() < deadline;
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        loaded = await options.admin.config();
        if (loaded === undefined) state = await options.job.state();
      }
      if (loaded === undefined && state === "stopped") return;
      if (loaded === undefined)
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
    // Any change in which CA issues which subjects restarts, conservatively: a Caddy with no issuer yet holds no certificates.
    if (
      expected !== undefined &&
      issuerCas(loaded).length > 0 &&
      issuancePolicies(loaded) !== issuancePolicies(expected)
    )
      await options.job.restart();
    else {
      const files = generationFiles(directory);
      const reload = await caddy(
        expected !== undefined
          ? [executable, "reload", "--config", files.adapted]
          : // A generation built before adapted JSON was kept is reloaded from its Caddyfile, once.
            [
              executable,
              "reload",
              "--config",
              files.main,
              "--adapter",
              "caddyfile",
            ],
        secret,
      );
      if (reload.exitCode !== 0) {
        const reason = lastOutputLine(reload.stderr);
        throw new RigError(
          kind === "route" ? "ROUTE_RELOAD" : "PROXY_RELOAD",
          `Caddy could not reload${reason ? ` (${reason})` : ""}${outcome}`,
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
        `Caddy answered, but does not serve generation ${basename(directory)}${outcome}`,
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
    const secret = await token(await acceptedSettings()).catch(() => undefined);
    await activate(current, await binary(), secret, kind, "reconcile");
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
  /** Publishes `settings` with every owned block rendered again, which drops directives an external router's
   * `extra_config` left in them; the route file is put back when the publication fails. */
  async function republishWith(
    settings: ProxySettings,
    kind: PublicationKind,
  ): Promise<void> {
    const raw = (await readText(paths.routes)) ?? "";
    const routes = canonicalRouteFile(raw).text;
    // Checked before anything is written: no file, backup or generation ever holds a hostname with two owners.
    assertOwners(routes, settings);
    if (routes !== raw) await writeRoutes(routes, raw);
    try {
      await publish(routes, kind, settings);
    } catch (error) {
      // Text Rig did not write is never put back.
      if (routes !== raw)
        await writeRoutes(canonicalRouteFile(raw).text, routes);
      throw error;
    }
  }
  /** The one-owner invariant for Rig's Caddy: `text`'s Target blocks and `settings`' proxy.routes, by bare hostname. */
  function assertOwners(text: string, settings: ProxySettings): void {
    assertSingleOwners(text, bareHostname, {
      sites: hostRoutes(settings).map((route) => route.hostname),
      owner: "proxy.routes in Host config",
    });
  }
  /** The route file as Rig's Caddy may publish it: only what Rig renders from its owned blocks. */
  async function canonicalRoutes(): Promise<{ raw: string; routes: string }> {
    const raw = (await readText(paths.routes)) ?? "";
    return { raw, routes: canonicalRouteFile(raw).text };
  }
  /** The route edit `route` or `restoration` makes, refused as `editRouteFile` refuses it, against the owner's routes Caddy
   * accepted and the hostnames another deploy has checked and is about to publish. */
  async function edited(
    before: string,
    key: string,
    route?: RouteRequest,
    restoration?: { saved: RouteCheckpoint; expected: RouteCheckpoint },
  ) {
    // A restoration publishes the saved block's sites, so they are held to the same reservations and owner routes as a new
    // route's: a rollback never takes a hostname another deploy reserved or the owner's routes hold.
    const sites =
      route?.sites ??
      (restoration?.saved.value
        ? parseOwnedSites(restoration.saved.value)
        : []);
    const owned = hostRoutes(await acceptedSettings()).map(
      (entry) => entry.hostname,
    );
    for (const site of sites) {
      const hostname = bareHostname(site.hostname);
      const holder = [...reservations].find(
        ([other, hosts]) => other !== key && hosts.includes(hostname),
      );
      if (holder)
        throw new RigError(
          "ROUTE_CONFLICT",
          `The hostname ${site.hostname} is about to be published by another deploy.`,
          "Wait for that deploy to finish, or choose a different hostname.",
          { hostname: site.hostname, owner: "another deploy" },
        );
      if (restoration && owned.includes(hostname))
        throw new RigError(
          "ROUTE_CONFLICT",
          `The hostname ${site.hostname} is served by proxy.routes in Host config.`,
          "Remove it from proxy.routes and run rig proxy reload, then restore the route.",
          { hostname: site.hostname, owner: "proxy.routes in Host config" },
        );
    }
    return editRouteFile({
      before,
      key,
      ...(route ? { route } : {}),
      ...(restoration ? { restoration } : {}),
      siteConfig: [],
      reserved: { sites: owned, owner: "proxy.routes in Host config" },
    });
  }
  async function change(
    key: string,
    route?: RouteRequest,
    restoration?: { saved: RouteCheckpoint; expected: RouteCheckpoint },
  ): Promise<void> {
    // Nothing changes while what Caddy serves is unknown: a withdrawal must be served before its upstream may stop.
    await reconcile("route");
    // Only what Rig renders goes forward: text it did not write is dropped here and overwritten on disk.
    const { raw, routes: before } = await canonicalRoutes();
    const current = await currentGeneration();
    // A route change publishes with the settings Caddy last accepted: Host config Rig refused never blocks one.
    const settings = await acceptedSettings();
    const edit = await edited(before, key, route, restoration);
    const after = edit?.after ?? before;
    // Done only when Caddy serves exactly this, which reconcile just confirmed for the current generation. A route file
    // ahead of it (a crash between writing it and publishing) is published here, even when this change adds nothing.
    const served = current
      ? await readText(generationFiles(current).routes)
      : undefined;
    // A reservation outlives every change the deploy makes (a withdrawal, the candidate's route, a restoration): only the
    // deploy's release, once it is decided, ends it.
    if (after === served) {
      if (raw !== after) await writeRoutes(after, raw);
      return;
    }
    // A change that leaves this Target's block as it is and as Caddy serves it (such as rolling back a route that never
    // changed) has nothing of its own to publish; whatever else the file holds is published by its own change.
    if (
      served !== undefined &&
      ownedBlock(after, key) === ownedBlock(before, key) &&
      ownedBlock(served, key) === ownedBlock(after, key)
    )
      return;
    // The prospective file is checked before anything is written, so neither the route file nor its backup ever holds a
    // hostname with two owners. A change that removes one of two owners passes; one that leaves a duplicate in place does
    // not, since publishing it would serve the duplicate.
    assertOwners(after, settings);
    if (after !== raw) await writeRoutes(after, raw);
    try {
      await publish(after, "route", settings);
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
      // What a deploy asks before it stops anything: whether this route would be refused.
      // What a deploy asks before it stops anything: whether this route would be refused. Its hostnames are then reserved
      // until the route is applied, rolled back or removed, so a Host config published in between cannot claim them.
      release: (key) =>
        queued(async () => {
          reservations.delete(key);
        }),
      // The reservation covers the candidate's hostnames and those the route serves now (the previous Deployment's), since a
      // failed deploy restores them: until it is decided, no reload or other deploy can take either.
      check: (route) =>
        queued(async () => {
          const { routes } = await canonicalRoutes();
          // The whole prospective route file, with this Target's change applied (a route-free candidate removes its block),
          // must keep one owner per hostname before anything stops: a duplicate elsewhere would fail the publication later.
          const edit = await edited(
            routes,
            route.key,
            route.sites.length ? route : undefined,
          );
          assertOwners(edit?.after ?? routes, await acceptedSettings());
          const serving = parseOwnedSites(ownedBlock(routes, route.key) ?? "");
          reservations.set(route.key, [
            ...new Set(
              [...route.sites, ...serving].map((site) =>
                bareHostname(site.hostname),
              ),
            ),
          ]);
        }),
    },
    republish: () =>
      queued(async () => {
        const requested = await options.settings();
        const before = (await readText(paths.routes)) ?? "";
        const current = await currentGeneration();
        if (
          current &&
          !canonicalRouteFile(before).dropped &&
          (await metadataOf(current))?.settings === settingsDigest(requested) &&
          (await readText(generationFiles(current).routes)) === before &&
          (await adaptedOf(current)) !== undefined
        ) {
          // The files say it; Caddy must too. A crash after the switch leaves Caddy on the previous generation, a CA change
          // included, until this makes it serve the current one.
          await rm(paths.rejectedSettings, { force: true });
          await reconcile("settings");
          return { published: false };
        }
        try {
          await republishWith(requested, "settings");
          await rm(paths.rejectedSettings, { force: true });
          return { published: true };
        } catch (error) {
          if (
            !current ||
            !(error instanceof RigError) ||
            !SETTINGS_REFUSALS.has(error.code)
          )
            throw error;
          await recordRejection(requested, error);
          // Rig's routes go on with the settings Caddy last accepted, so a route file ahead of what Caddy serves still is.
          const accepted = await acceptedSettings();
          await reconcile("settings");
          const routes = canonicalRouteFile(before).text;
          if (
            routes !== (await readText(generationFiles(current).routes)) ||
            (await metadataOf(current))?.settings !== settingsDigest(accepted)
          )
            await republishWith(accepted, "route");
          throw new RigError(
            error.code,
            error.message,
            `${error.hint} Caddy keeps serving the proxy settings it last accepted; rig proxy shows the refused ones as pending.`,
            { ...error.details, pending: true },
          );
        }
      }),
  };
}
