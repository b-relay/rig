import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
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
import type { PublishedDashboard } from "../domain/managed-proxy";
import { UPSTREAM_HOST, takesUpstream } from "../domain/route-upstream";
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
/** The first wait between looks for a starting dashboard on its address, or between publications Caddy did not take; each
 * doubles it, up to MAX_LOOK_MS. */
const FIRST_LOOK_MS = 100;
const MAX_LOOK_MS = 5_000;
/** How long a running dashboard may go unfound on its address before rigd reports it, by default. */
const UNVERIFIED_REPORT_MS = 30_000;
/** How long a takeover waits before asking Caddy again. */
const TAKEOVER_RETRY_MS = 5_000;

export const DASHBOARD: NoticeChannel = {
  name: "dashboard",
  consequence:
    "The dashboard is not being served, or Rig's Caddy does not route its domain to it; rigd keeps trying, starting it again after a back-off of up to a minute.",
  hint: "Read logs/dashboard/dashboard.log under the Rig root. If another program holds the port, stop it, or set dashboard.port in config.yaml under the Rig root and run rigd install. If Caddy is the cause, run rig doctor.",
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
/** The route of a published dashboard: its domain, to its port on 127.0.0.1, which Rig's Caddy reaches only while rigd has
 * found its own dashboard listening there (see Dashboard.route); and Caddy's HTTPS port it was published on, which is part
 * of the address the dashboard admits (see dashboardPublication). */
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
/** Pure: proxy settings with the dashboard's route beside the owner's proxy.routes, as DNS records name the hostnames Rig's
 * Caddy serves. Never what Caddy publishes: the dashboard's upstream comes only from rigd's verified dashboard (see
 * Dashboard.route). Host config refuses a domain proxy.routes already has. */
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
/** The proxy settings Rig's Caddy publishes while rigd serves the dashboard `route`: Host config's, beside which Caddy serves
 * the dashboard's route as rigd verified it (see Dashboard.route). Settings that move Caddy's HTTPS port are refused,
 * PROXY_CONFIG: the running dashboard admits only the address it was started with, so the move waits for rigd install,
 * which starts both anew; Caddy keeps the settings it last accepted meanwhile. */
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
  return settings;
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

/** The dashboard an earlier rigd recorded and left running (one that was killed), or undefined, with its record removed,
 * when the record names no running process: none recorded, one that is not a record (torn, or edited by hand), or one
 * that has exited. Only the very process recorded counts: its pid and start time must both match. */
async function leftOverDashboard(
  root: string,
): Promise<ProcessRecord | undefined> {
  const record = recordPath(root);
  const recorded = await readFile(record, "utf8")
    .then((text) => recordSchema.parse(JSON.parse(text)))
    .catch(() => undefined);
  if (recorded && (await recordedProcess(recorded)) === "running")
    return recorded;
  await rm(record, { force: true });
  return undefined;
}
/** Stops the dashboard an earlier rigd recorded and left running, if any (see leftOverDashboard), and removes its record. */
export async function stopLeftOverDashboard(root: string): Promise<void> {
  const recorded = await leftOverDashboard(root);
  if (recorded) {
    signal(recorded.pid, "SIGTERM");
    for (
      const until = Date.now() + STOP_GRACE_MS;
      Date.now() < until && (await recordedProcess(recorded)) === "running";
    )
      await Bun.sleep(100);
    if ((await recordedProcess(recorded)) === "running")
      signal(recorded.pid, "SIGKILL");
  }
  await rm(recordPath(root), { force: true });
}
/** Stops a dashboard an earlier rigd left running (see stopLeftOverDashboard), whether or not this rigd serves one, so it
 * does not keep the port or serve unseen; but only once `withheld` has confirmed that Rig's Caddy routes no dashboard
 * domain to a port, so the port it frees is never routed. Until then it keeps running, and `withheld` is asked again every
 * 5 s, each failure reported. Resolves true once none is left running; false when rigd stops first (`stopped`), leaving it
 * for the next rigd. */
export async function takeOverDashboard(deps: {
  readonly root: string;
  /** Resolves once Rig's Caddy is confirmed to route no dashboard domain to a port; rejects saying why not. */
  withheld(): Promise<void>;
  report(message: string): void;
  stopped(): boolean;
  wait(ms: number): Promise<void>;
}): Promise<boolean> {
  const left = await leftOverDashboard(deps.root);
  if (!left) return true;
  for (;;) {
    if (deps.stopped()) return false;
    try {
      await deps.withheld();
      break;
    } catch (error) {
      deps.report(
        `A dashboard an earlier rigd left running (pid ${left.pid}) keeps running until Rig's Caddy is confirmed to withhold its domain (${failure(error)}); rigd tries again in ${TAKEOVER_RETRY_MS / 1000} s.`,
      );
    }
    await deps.wait(TAKEOVER_RETRY_MS);
  }
  if (deps.stopped()) return false;
  await stopLeftOverDashboard(deps.root);
  return true;
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
  /** What a process listens on: the dashboard is served only once its own process listens on 127.0.0.1:<port>. */
  readonly listeners: ListenerInspection;
  /** Has Rig's Caddy serve the dashboard's route as `Dashboard.route` says now; resolves once Caddy is confirmed to, and
   * rejects when it could not be. Absent when the dashboard is not published. */
  publish?(): Promise<void>;
  /** How long a running dashboard may go unfound on its address before rigd reports it; 30 s when absent. */
  readonly unverifiedReportMs?: number;
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
  /** The route Rig's Caddy serves for it now: its domain to its port only while rigd has found its own running dashboard
   * listening there, and withheld otherwise; undefined when it is not published. */
  route(): PublishedDashboard | undefined;
  /** Why it is not served now, as it last reported; undefined while it is, or while it first starts. */
  problem(): string | undefined;
  /** Says why it is not served: to doctor (its notice), rigd status (`problem`) and its log. */
  report(message: string): void;
  /** Starts it and keeps it running until `stop`; nothing once stopped. */
  start(): void;
  /** Has Rig's Caddy withhold its domain and, once Caddy is confirmed to, stops it. Until then it keeps running and its
   * domain may still reach it, never another program: the withholding is tried again until Caddy takes it. */
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
  /** The port Caddy may route the domain to: set only while this rigd's own running dashboard is found listening there. */
  let routed: number | undefined;
  let problem: string | undefined;
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
  const report = (message: string) => {
    problem = message;
    deps.notices.note(DASHBOARD, message);
    return log(`[rigd] ${message}\n`);
  };
  const where = `${UPSTREAM_HOST}:${deps.port}`;
  /** Has Caddy withhold the domain: tried again until it is confirmed to, or until `signal` aborts (rigd is stopping, and its
   * stop withholds it). */
  const withhold = async (signal?: AbortSignal) => {
    routed = undefined;
    for (let attempt = 1; deps.publish; attempt++) {
      try {
        await deps.publish();
        return;
      } catch (error) {
        const delay = lookDelay(attempt);
        await report(
          `Rig's Caddy has not confirmed that it withholds ${deps.published?.domain} from ${where} (${failure(error)}); ${signal ? "" : "the dashboard keeps running until it does, and "}rigd tries again in ${seconds(delay)}.`,
        );
        if (signal?.aborted) return;
        await pause(delay, signal);
      }
    }
  };
  /** Waits until `run`'s own process listens on 127.0.0.1:<port>, then has Caddy route the domain there, looking again before
   * every attempt, so a process that ended or never bound is never routed. True once it is served; false once it ended or
   * rigd stops first. */
  const serve = async (run: Run): Promise<boolean> => {
    const pid = run.child.pid;
    if (pid === undefined) return false;
    let reportAt =
      Date.now() + (deps.unverifiedReportMs ?? UNVERIFIED_REPORT_MS);
    for (let attempt = 1; ; attempt++) {
      const evidence = await deps.listeners.inspect(pid, stopping.signal);
      // Checked with nothing awaited before the route is set, so a stop or an exit already seen is never routed past.
      if (ended(run) || stopping.signal.aborted) return false;
      if (
        evidence.state === "observed" &&
        evidence.listeners.some(
          (listener) =>
            listener.port === deps.port && takesUpstream(listener.address),
        )
      ) {
        routed = deps.port;
        try {
          await deps.publish?.();
          problem = undefined;
          return true;
        } catch (error) {
          routed = undefined;
          await report(
            `Rig's Caddy could not be made to route ${deps.published?.domain} to the dashboard (${failure(error)}); rigd tries again in ${seconds(lookDelay(attempt))}.`,
          );
        }
      } else if (Date.now() >= reportAt) {
        reportAt = Number.POSITIVE_INFINITY;
        const why =
          evidence.state === "unknown"
            ? `rigd could not read what it listens on (${evidence.reason})`
            : `it does not listen on ${where}${(await answers(deps.port)) ? ", where another program answers" : ""}`;
        await report(
          `The dashboard runs, but ${why}${deps.publish ? ", so Rig's Caddy does not route its domain to it" : ""}.`,
        );
      }
      await Promise.race([
        run.ended,
        pause(lookDelay(attempt), stopping.signal),
      ]);
    }
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
        const served = await serve(run);
        // Once it has been served steadily, an earlier failure no longer stands.
        const steady = served
          ? setTimeout(() => deps.notices.clear(DASHBOARD), STEADY_MS)
          : undefined;
        how = await run.ended;
        clearTimeout(steady);
      }
      current = undefined;
      if (stopping.signal.aborted) break;
      // Withheld as soon as it ended: any program may take the port it freed.
      await withhold(stopping.signal);
      if (stopping.signal.aborted) break;
      // It has ended, so whatever answers there now is another program, which may be why it could not start.
      if (await answers(deps.port))
        how = `${how}, and another program holds ${where}`;
      inARow = deps.now() - startedAt >= STEADY_MS ? 1 : inARow + 1;
      const delay = Math.min(
        FIRST_RESTART_MS * 2 ** (inARow - 1),
        MAX_RESTART_MS,
      );
      await report(
        `The dashboard ${how}; rigd starts it again in ${seconds(delay)}.`,
      );
      await deps.wait(delay, stopping.signal);
    }
    await rm(record, { force: true });
  };
  return {
    url: `http://127.0.0.1:${deps.port}`,
    serving: describeDashboard(deps.port, deps.published),
    route: () =>
      deps.published && {
        domain: deps.published.domain,
        port: routed ?? null,
      },
    problem: () => problem,
    report: (message) => void report(message),
    start() {
      if (!stopping.signal.aborted) running ??= loop();
    },
    async stop() {
      stopping.abort();
      // Confirmed withheld before the process is signalled, so the port it frees is never routed. A publication under way
      // runs first, and reads the route as it is by then: withheld. With no process running, nothing of rigd's holds the
      // port to keep another program from it, so the withholding is asked once and rigd stops either way.
      const run = current;
      if (run && !ended(run)) {
        await withhold();
        await terminate(run);
      } else await withhold(stopping.signal);
      await running;
      await writing;
    },
  };
}

/** Whether a program accepts a connection on 127.0.0.1:`port` now, to name a port another program holds. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: UPSTREAM_HOST, port });
    const settle = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(2000, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}
/** Whether `run`'s process has exited, or never started. */
function ended(run: Run): boolean {
  return (
    run.child.pid === undefined ||
    run.child.exitCode !== null ||
    run.child.signalCode !== null
  );
}
/** The wait before look or attempt `attempt`, from FIRST_LOOK_MS doubling up to MAX_LOOK_MS. */
function lookDelay(attempt: number): number {
  return Math.min(FIRST_LOOK_MS * 2 ** (attempt - 1), MAX_LOOK_MS);
}
/** Resolves after `ms`, or early once `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}
function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
