import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { HostConfig } from "../config/types";
import { RigError } from "../domain/errors";
import type { DoctorCheck } from "./offline-doctor";
import type { ProxySettings } from "../config/proxy-schema";
import type { LogRetention } from "../domain/log-retention";
import { RIG_VERSION } from "../domain/version";
import { rotateLogFile } from "../providers/target-log";
import type { ListenerInspection } from "../providers/listener-inspection";
import { takesUpstream } from "../domain/route-upstream";
import type { NoticeBoard, NoticeChannel } from "./notices";
import {
  processStartTime,
  recordedProcess,
  type ProcessRecord,
} from "./process-identity";

/** How long the dashboard must run before an exit counts as a fresh failure rather than the next in a row. */
const STEADY_MS = 60_000;
/** The first wait before starting it again; each exit in a row doubles it, up to MAX_RESTART_MS. */
const FIRST_RESTART_MS = 1_000;
const MAX_RESTART_MS = 60_000;
/** How long a stop waits after SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 5_000;
/** The first wait between looks at what a starting dashboard listens on; each look doubles it, up to MAX_CONFIRM_MS. */
const FIRST_CONFIRM_MS = 100;
const MAX_CONFIRM_MS = 2_000;
/** How long a running dashboard may go unconfirmed before rigd reports it, by default. */
const UNCONFIRMED_NOTICE_MS = 30_000;

export const DASHBOARD: NoticeChannel = {
  name: "dashboard",
  consequence:
    "The dashboard is not being served; rigd starts it again after a back-off of up to a minute.",
  hint: "Read logs/dashboard/dashboard.log under the Rig root. If another program holds the port, set dashboard.port in config.yaml under the Rig root, then run rigd install.",
};

/** Pure: where the dashboard built with this rigd is installed: `<root>/dashboard/v<release>`. */
export function dashboardDirectory(
  root: string,
  release: string = RIG_VERSION,
): string {
  return join(root, "dashboard", `v${release}`);
}
/** Where the dashboard is published beyond this Mac: Rig's Caddy serves `domain` at `authority`, and `trustedClients`,
 * when listed, are the only addresses besides this Mac that may reach it there and sign in with the access key. */
export interface DashboardPublication {
  readonly domain: string;
  /** What browsers address it as, `host[:port]`: the domain, with Caddy's HTTPS port when that is not 443. */
  readonly authority: string;
  readonly trustedClients: readonly string[];
}
/** Pure: how a dashboard is served, as rigd status shows it and rigd install compares it: `http://127.0.0.1:4280`, or
 * `https://rig.example.com via http://127.0.0.1:4280, trusting 100.64.0.0/10`. */
export function describeDashboard(
  port: number,
  published?: DashboardPublication,
): string {
  const local = `http://127.0.0.1:${port}`;
  if (!published) return local;
  const trusting = published.trustedClients.length
    ? `, trusting ${published.trustedClients.join(", ")}`
    : "";
  return `https://${published.authority} via ${local}${trusting}`;
}
/** Pure: the publication Host config asks of the dashboard, if any. */
export function dashboardPublication(
  host: Pick<HostConfig, "dashboard" | "proxy">,
): DashboardPublication | undefined {
  if (host.dashboard === false || host.dashboard.domain === undefined)
    return undefined;
  const https = host.proxy?.ports.https ?? 443;
  return {
    domain: host.dashboard.domain,
    authority:
      https === 443
        ? host.dashboard.domain
        : `${host.dashboard.domain}:${https}`,
    trustedClients: host.dashboard.trusted_clients,
  };
}
/** The route Rig's Caddy serves for a published dashboard: its domain, to its port on 127.0.0.1; and Caddy's HTTPS port
 * it was published on, which is part of the address the dashboard admits (see dashboardPublication). */
export interface DashboardRoute {
  readonly domain: string;
  readonly port: number;
  readonly https: number;
}
/** The route of the dashboard a rigd started now would publish: Host config's domain and port, when the dashboard is on,
 * published, and installed for this release; otherwise none, so Caddy never sends visitors to a port nothing of Rig's
 * serves. rigd reads it once as it starts, beside the dashboard it starts, so the two never disagree; doctor and rigd
 * install read it to say what applying Host config would publish. */
export async function configuredDashboardRoute(
  root: string,
  host: Pick<HostConfig, "dashboard" | "proxy">,
): Promise<DashboardRoute | undefined> {
  if (host.dashboard === false || host.dashboard.domain === undefined)
    return undefined;
  const server = join(dashboardDirectory(root), "web", "server.js");
  if (!(await stat(server).catch(() => undefined))?.isFile()) return undefined;
  return {
    domain: host.dashboard.domain,
    port: host.dashboard.port,
    https: host.proxy?.ports.https ?? 443,
  };
}
/** Pure: proxy settings with the dashboard's route beside the owner's proxy.routes, so publication, conflicts, rig proxy,
 * DNS checks and verify serve and report it as one of them. Host config refuses a domain proxy.routes already has. */
export function withDashboardRoute(
  settings: ProxySettings,
  route: DashboardRoute | undefined,
): ProxySettings {
  return route
    ? {
        ...settings,
        routes: { ...settings.routes, [route.domain]: route.port },
      }
    : settings;
}
/** The proxy settings Rig's Caddy publishes while rigd serves the dashboard `route` (see withDashboardRoute). Settings that
 * move Caddy's HTTPS port are refused, PROXY_CONFIG: the running dashboard admits only the address it was started with,
 * so the move waits for rigd install, which starts both anew; Caddy keeps the settings it last accepted meanwhile. */
export function publishedProxySettings(
  settings: ProxySettings,
  route: DashboardRoute | undefined,
): ProxySettings {
  if (route && settings.ports.https !== route.https)
    throw new RigError(
      "PROXY_CONFIG",
      `proxy.ports.https is now ${settings.ports.https}, but the dashboard rigd serves at ${route.domain} was started for ${route.https}, so it would refuse the new address.`,
      "Run rigd install to apply the new port to Caddy and the dashboard together. Caddy keeps the settings it last accepted until then.",
      { https: settings.ports.https, published: route.https },
    );
  return withDashboardRoute(settings, route);
}
/** How a rigd started now would serve the dashboard (see describeDashboard): Host config's settings, when it is on and
 * this release's dashboard is installed; otherwise undefined, since that rigd serves none. `rigd install` compares it
 * with what the running rigd reports, so a changed setting starts a rigd that applies it. */
export async function dashboardServing(
  root: string,
  host: Pick<HostConfig, "dashboard" | "proxy">,
): Promise<string | undefined> {
  if (host.dashboard === false) return undefined;
  const server = join(dashboardDirectory(root), "web", "server.js");
  if (!(await stat(server).catch(() => undefined))?.isFile()) return undefined;
  return describeDashboard(host.dashboard.port, dashboardPublication(host));
}

/** Pure: the doctor check of the dashboard: passing while rigd serves it as Host config asks (or both serve none), and
 * failing with how to apply an edit when they differ, since rigd reads the dashboard's settings only as it starts. */
export function dashboardCheck(
  asked: string | undefined,
  serving: string | undefined,
): DoctorCheck {
  if (asked === serving)
    return {
      name: "dashboard",
      ok: true,
      message: serving
        ? `rigd serves the dashboard at ${serving}.`
        : "rigd serves no dashboard: it is off, or none is installed for this release.",
    };
  return {
    name: "dashboard",
    ok: false,
    message: `Host config asks for the dashboard ${asked ? `at ${asked}` : "off"}, but rigd serves ${serving ? `it at ${serving}` : "none"}.`,
    reason: "dashboard-pending",
    hint: "Run rigd install: rigd reads the dashboard's settings as it starts, and rig proxy reload leaves its route as rigd started it.",
  };
}

const recordPath = (root: string) => join(root, "dashboard", "process.json");
/** The record of a running dashboard: its pid and the start time ps reported, which together name that one process. */
const recordSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});

/** Stops the dashboard an earlier rigd recorded and left running (one that was killed), whether or not this rigd serves
 * one, so it does not keep the port or serve unseen. Only the very process recorded is stopped: its pid and start time
 * must both match. */
export async function stopLeftOverDashboard(root: string): Promise<void> {
  const record = recordPath(root);
  let recorded: ProcessRecord;
  try {
    recorded = recordSchema.parse(JSON.parse(await readFile(record, "utf8")));
  } catch {
    // None recorded; or one that is not a record (torn, or edited by hand), which names no process to stop.
    await rm(record, { force: true });
    return;
  }
  if ((await recordedProcess(recorded)) === "running") {
    signal(recorded.pid, "SIGTERM");
    for (
      const until = Date.now() + STOP_GRACE_MS;
      Date.now() < until && (await recordedProcess(recorded)) === "running";
    )
      await Bun.sleep(100);
    if ((await recordedProcess(recorded)) === "running")
      signal(recorded.pid, "SIGKILL");
  }
  await rm(record, { force: true });
}

/** How long a takeover waits before asking Caddy again. */
const TAKEOVER_RETRY_MS = 5_000;
/** Stops the dashboard an earlier rigd left running, then starts this rigd's, once `confirm` says Caddy is confirmed to
 * withhold every dashboard domain (this rigd's, and any an earlier one published): until then the left-over one keeps its
 * port, which Caddy may still route to it, and `confirm` is asked again every 5 s. Gives up once `stopped` holds. */
export async function takeOverDashboard(deps: {
  confirm(): Promise<boolean>;
  stopLeftOver(): Promise<void>;
  start(): void;
  stopped(): boolean;
  wait(ms: number): Promise<void>;
}): Promise<void> {
  while (!(await deps.confirm())) {
    if (deps.stopped()) return;
    await deps.wait(TAKEOVER_RETRY_MS);
    if (deps.stopped()) return;
  }
  if (deps.stopped()) return;
  await deps.stopLeftOver();
  deps.start();
}

export interface DashboardDependencies {
  readonly root: string;
  readonly port: number;
  /** The installed dashboard to run; its server is `<directory>/web/server.js`. */
  readonly directory: string;
  /** rigd's own executable, which runs the server as Bun (BUN_BE_BUN=1); from source, Bun itself. */
  readonly executable: string;
  /** Where Rig's Caddy publishes it, when Host config names a domain. */
  readonly published?: DashboardPublication;
  /** The Host's Target log sizes, which the dashboard's log follows too. */
  retention(): Promise<LogRetention>;
  readonly notices: Pick<NoticeBoard, "note" | "clear">;
  /** What the dashboard's process listens on: only once it holds 127.0.0.1:<port> itself is it served. */
  readonly listeners: ListenerInspection;
  /** Whether some program answers on `port` now, to tell a port another program holds from any other failed start. */
  portTaken(port: number): Promise<boolean>;
  /** Told, and awaited, when rigd confirms its own dashboard holds its address, and again when that ends, before a stop
   * signals the process: Rig's Caddy routes the dashboard's domain to its port only in between. Resolves once Caddy serves
   * that; rejects when it could not be made to, and the domain then stays withheld. */
  serving(listening: boolean): Promise<void>;
  /** How long a running dashboard may go unconfirmed before rigd reports it; 30 s when absent. */
  readonly unconfirmedNoticeMs?: number;
  /** Resolves after `ms`, or early once `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

/** The dashboard rigd runs: started with rigd, kept running, stopped with it. */
export interface Dashboard {
  /** Where it is served: http://127.0.0.1:<port>. */
  readonly url: string;
  /** How it is served, with where it is published (see describeDashboard). */
  readonly serving: string;
  /** Why it is not served now, as its notice says: its last failure, until a run is confirmed to hold its address and Caddy
   * routes to it; undefined while it serves or first starts. */
  problem(): string | undefined;
  /** Starts it and keeps it running until `stop`. */
  start(): void;
  stop(): Promise<void>;
}

/** One run of the dashboard: its process and how it ended, settled once it has exited or could not start. */
interface Run {
  readonly child: ChildProcess;
  readonly ended: Promise<string>;
}

/** The dashboard this rigd can run, or undefined when none is installed for its release (a rigd run from source, or one
 * whose release shipped none). */
export async function openDashboard(
  deps: DashboardDependencies,
): Promise<Dashboard | undefined> {
  const server = join(deps.directory, "web", "server.js");
  if (!(await stat(server).catch(() => undefined))?.isFile()) return undefined;
  const record = recordPath(deps.root);
  const logFile = join(deps.root, "logs", "dashboard", "dashboard.log");
  const stopping = new AbortController();
  let current: Run | undefined;
  let running: Promise<void> | undefined;
  /** What Caddy was last confirmed to do with the dashboard's domain: route it here (true) or withhold it (false); unknown
   * after a publication that failed. */
  let routed: boolean | "unknown" = false;
  let problem: string | undefined;
  /** Set by a stop that could not withhold the domain: the process is left running, recorded, for the next rigd. */
  let leftBehind = false;
  let leave = () => {};
  const left = new Promise<string>((resolve) => {
    leave = () => resolve("was left running");
  });
  /** Publications run one at a time, in order, so a stop's withholding follows any enable already under way. */
  let publishing: Promise<unknown> = Promise.resolve();
  const serve = (now: boolean): Promise<void> => {
    const next = publishing
      .catch(() => {})
      .then(async () => {
        if (routed === now || (now && stopping.signal.aborted)) return;
        try {
          await deps.serving(now);
          routed = now;
        } catch (error) {
          routed = "unknown";
          throw error;
        }
      });
    publishing = next;
    return next;
  };
  /** Says why the dashboard is not served, to doctor, rigd status and its log. */
  const report = (message: string) => {
    problem = message;
    deps.notices.note(DASHBOARD, message);
    void log(`[rigd] ${message}\n`);
  };
  /** Reports a publication Caddy did not take and waits out the back-off of `attempt`. */
  const retryAfter = async (attempt: number, now: boolean, error: unknown) => {
    const delay = Math.min(
      FIRST_RESTART_MS * 2 ** (attempt - 1),
      MAX_RESTART_MS,
    );
    report(
      `Rig's Caddy could not be made to ${now ? "route the dashboard's domain to it" : "withhold the dashboard's domain"} (${error instanceof Error ? error.message : String(error)}); rigd tries again in ${Math.round(delay / 1000)} s.`,
    );
    await deps.wait(delay, stopping.signal);
  };
  /** Routes the domain to `run` once its own process is found on the dashboard's address, looking again before every
   * attempt, so a process that ended or was replaced during a back-off is never published. Says whether it was ever found,
   * and whether Caddy routes to it now. */
  const enable = async (
    run: Run,
  ): Promise<{ confirmed: boolean; served: boolean }> => {
    let confirmed = false;
    for (let attempt = 1; ; attempt++) {
      if (!(await confirm(run))) return { confirmed, served: false };
      confirmed = true;
      try {
        await serve(true);
        return { confirmed, served: routed === true };
      } catch (error) {
        await retryAfter(attempt, true, error);
      }
    }
  };
  /** Withholds the domain, tried again on the back-off until Caddy takes it or rigd stops, whose own stop withholds it. */
  const disable = async () => {
    for (let attempt = 1; !stopping.signal.aborted; attempt++)
      try {
        await serve(false);
        return;
      } catch (error) {
        await retryAfter(attempt, false, error);
      }
  };
  /** Waits until `run`'s own process holds the dashboard's address, 127.0.0.1:<port>: true once it does, false once it
   * ended or rigd stops it first. Something else answering there is never taken for it. */
  const confirm = async (run: Run): Promise<boolean> => {
    const pid = run.child.pid;
    if (pid === undefined) return false;
    let ended = false;
    void run.ended.then(() => (ended = true));
    const reportAt =
      Date.now() + (deps.unconfirmedNoticeMs ?? UNCONFIRMED_NOTICE_MS);
    let reported = false;
    for (let wait = FIRST_CONFIRM_MS; !ended && !stopping.signal.aborted;) {
      const evidence = await deps.listeners.inspect(pid, stopping.signal);
      if (!reported && Date.now() >= reportAt) {
        reported = true;
        report(
          `The dashboard runs, but rigd has not confirmed that it listens on 127.0.0.1:${deps.port} (${evidence.state === "unknown" ? evidence.reason : "it listens elsewhere"}), so it is not served.`,
        );
      }
      if (
        evidence.state === "observed" &&
        evidence.listeners.some(
          (listener) =>
            listener.port === deps.port && takesUpstream(listener.address),
        )
      )
        return !ended && !stopping.signal.aborted;
      await Promise.race([run.ended, Bun.sleep(wait)]);
      wait = Math.min(wait * 2, MAX_CONFIRM_MS);
    }
    return false;
  };
  // Output is appended in order, one write at a time, rotating a full file first.
  let writing: Promise<void> = Promise.resolve();
  const log = (text: string) => {
    writing = writing
      .then(async () => {
        await mkdir(join(deps.root, "logs", "dashboard"), {
          recursive: true,
          mode: 0o700,
        });
        await rotateLogFile(logFile, await deps.retention());
        await appendFile(logFile, text, { mode: 0o600 });
      })
      .catch(() => {});
    return writing;
  };
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    BUN_BE_BUN: "1",
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(deps.port),
    RIG_ROOT: deps.root,
    // Every browser signs in with this key, on this Mac too.
    RIG_WEB_KEY_FILE: join(deps.root, "auth", "dashboard.key"),
    // Published, it is the dashboard at that host; a non-empty trusted list limits who may reach it there.
    ...(deps.published
      ? {
          RIG_WEB_HOST: deps.published.authority,
          RIG_WEB_DASHBOARD_HOST: deps.published.authority,
          RIG_WEB_TRUSTED_CLIENTS: deps.published.trustedClients.join(","),
        }
      : {}),
  };
  const launch = (): Run => {
    const child = spawn(deps.executable, ["server.js"], {
      cwd: join(deps.directory, "web"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => void log(String(chunk)));
    child.stderr?.on("data", (chunk) => void log(String(chunk)));
    // A process that could not start emits error and never exit, so either settles the run.
    const ended = new Promise<string>((resolve) => {
      child.once("error", (error) =>
        resolve(`could not start (${error.message})`),
      );
      child.once("exit", (code, signal) =>
        resolve(signal ? `was ended by ${signal}` : `exited with code ${code}`),
      );
    });
    return { child, ended };
  };
  // Recorded with its start time, so a later rigd stops this very process and never another that reused its pid. Written
  // beside the record and renamed over it, so a crash never leaves a torn record.
  const remember = async (pid: number): Promise<boolean> => {
    try {
      const startedAt = await processStartTime(pid);
      if (startedAt === undefined) return false;
      const staged = `${record}.${process.pid}`;
      await writeFile(staged, JSON.stringify({ pid, startedAt }), {
        mode: 0o600,
      });
      await rename(staged, record);
      return true;
    } catch {
      return false;
    }
  };
  const loop = async () => {
    let inARow = 0;
    while (!stopping.signal.aborted) {
      const startedAt = deps.now();
      const run = launch();
      current = run;
      let how: string;
      if (run.child.pid !== undefined && !(await remember(run.child.pid))) {
        // A dashboard no later rigd could find and stop must not run, or it would keep the port after a crash.
        await terminate(run);
        how = `could not be recorded in ${record}, so it was stopped`;
      } else {
        let steady: ReturnType<typeof setTimeout> | undefined;
        const { confirmed, served } = await enable(run);
        if (served) {
          problem = undefined;
          // Once it has served steadily, an earlier failure no longer stands.
          steady = setTimeout(() => deps.notices.clear(DASHBOARD), STEADY_MS);
        }
        how = await Promise.race([run.ended, left]);
        clearTimeout(steady);
        if (leftBehind) break;
        // Withheld as soon as it ended: any program may bind the port it freed.
        await disable();
        if (
          !confirmed &&
          !stopping.signal.aborted &&
          (await deps.portTaken(deps.port))
        )
          how = `${how}: another program holds port ${deps.port}`;
      }
      current = undefined;
      if (stopping.signal.aborted) break;
      inARow = deps.now() - startedAt >= STEADY_MS ? 1 : inARow + 1;
      const delay = Math.min(
        FIRST_RESTART_MS * 2 ** (inARow - 1),
        MAX_RESTART_MS,
      );
      const message = `The dashboard ${how}; rigd starts it again in ${Math.round(delay / 1000)} s.`;
      problem = message;
      deps.notices.note(DASHBOARD, message);
      await log(`[rigd] ${message}\n`);
      await deps.wait(delay, stopping.signal);
    }
    if (!leftBehind) await rm(record, { force: true });
  };
  return {
    url: `http://127.0.0.1:${deps.port}`,
    serving: describeDashboard(deps.port, deps.published),
    problem: () => problem,
    start() {
      running ??= loop();
    },
    async stop() {
      stopping.abort();
      // Withheld, and served so, before the process is signalled, so the port it frees is never routed; publications run in
      // order, so this follows any enable already under way. When Caddy cannot be made to, the process keeps the port,
      // recorded, and the next rigd stops it once it has withheld the domain.
      const withheld = await serve(false).then(
        () => true,
        (error: unknown) => {
          report(
            `rigd stopped, but Rig's Caddy could not be made to withhold the dashboard's domain (${error instanceof Error ? error.message : String(error)}), so the dashboard was left running for the next rigd.`,
          );
          return false;
        },
      );
      if (current && withheld) await terminate(current);
      else if (current) {
        leftBehind = true;
        leave();
      }
      await running;
      await writing;
    },
  };
}

/** SIGTERM, then SIGKILL once STOP_GRACE_MS has passed; resolves once the run has ended, including one that never
 * started. */
async function terminate(run: Run): Promise<void> {
  const { child } = run;
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }, STOP_GRACE_MS);
  await run.ended;
  clearTimeout(timer);
}

/** Signals `pid`, ignoring one that has gone meanwhile. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    /* It exited between the check and the signal. */
  }
}
