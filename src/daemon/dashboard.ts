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
import type { LogRetention } from "../domain/log-retention";
import { RIG_VERSION } from "../domain/version";
import { rotateLogFile } from "../providers/target-log";
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
/** Where the dashboard is published beyond this Mac: Rig's Caddy serves `domain`, and `trustedClients` reach it without
 * the access key. */
export interface DashboardPublication {
  readonly domain: string;
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
  return `https://${published.domain} via ${local}${trusting}`;
}
/** Pure: the publication Host config asks of the dashboard, if any. */
export function dashboardPublication(
  dashboard: Exclude<HostConfig["dashboard"], false>,
): DashboardPublication | undefined {
  return dashboard.domain === undefined
    ? undefined
    : { domain: dashboard.domain, trustedClients: dashboard.trusted_clients };
}
/** How a rigd started now would serve the dashboard (see describeDashboard): Host config's settings, when it is on and
 * this release's dashboard is installed; otherwise undefined, since that rigd serves none. `rigd install` compares it
 * with what the running rigd reports, so a changed setting starts a rigd that applies it. */
export async function dashboardServing(
  root: string,
  host: Pick<HostConfig, "dashboard">,
): Promise<string | undefined> {
  if (host.dashboard === false) return undefined;
  const server = join(dashboardDirectory(root), "web", "server.js");
  if (!(await stat(server).catch(() => undefined))?.isFile()) return undefined;
  return describeDashboard(
    host.dashboard.port,
    dashboardPublication(host.dashboard),
  );
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
    // Published, it is the dashboard at that host: browsers beyond this Mac sign in with the key, unless trusted.
    ...(deps.published
      ? {
          RIG_WEB_HOST: deps.published.domain,
          RIG_WEB_DASHBOARD_HOST: deps.published.domain,
          RIG_WEB_KEY_FILE: join(deps.root, "auth", "dashboard.key"),
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
        // Once it has run steadily, an earlier failure no longer stands.
        const steady = setTimeout(
          () => deps.notices.clear(DASHBOARD),
          STEADY_MS,
        );
        how = await run.ended;
        clearTimeout(steady);
      }
      current = undefined;
      if (stopping.signal.aborted) break;
      inARow = deps.now() - startedAt >= STEADY_MS ? 1 : inARow + 1;
      const delay = Math.min(
        FIRST_RESTART_MS * 2 ** (inARow - 1),
        MAX_RESTART_MS,
      );
      const message = `The dashboard ${how}; rigd starts it again in ${Math.round(delay / 1000)} s.`;
      deps.notices.note(DASHBOARD, message);
      await log(`[rigd] ${message}\n`);
      await deps.wait(delay, stopping.signal);
    }
    await rm(record, { force: true });
  };
  return {
    url: `http://127.0.0.1:${deps.port}`,
    serving: describeDashboard(deps.port, deps.published),
    start() {
      running ??= loop();
    },
    async stop() {
      stopping.abort();
      if (current) await terminate(current);
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
