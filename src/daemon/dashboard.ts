import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
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

export interface DashboardDependencies {
  readonly root: string;
  readonly port: number;
  /** The installed dashboard to run; its server is `<directory>/web/server.js`. */
  readonly directory: string;
  /** rigd's own executable, which runs the server as Bun (BUN_BE_BUN=1); from source, Bun itself. */
  readonly executable: string;
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
  /** Stops a dashboard an earlier rigd left running, then starts this one and keeps it running until `stop`. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** The dashboard this rigd can run, or undefined when none is installed for its release (a rigd run from source, or one
 * whose release shipped none). */
export async function openDashboard(
  deps: DashboardDependencies,
): Promise<Dashboard | undefined> {
  const server = join(deps.directory, "web", "server.js");
  if (!(await stat(server).catch(() => undefined))?.isFile()) return undefined;
  const record = join(deps.root, "dashboard", "process.json");
  const logFile = join(deps.root, "logs", "dashboard", "dashboard.log");
  const stopping = new AbortController();
  let child: ChildProcess | undefined;
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
  };
  const loop = async () => {
    let inARow = 0;
    while (!stopping.signal.aborted) {
      const startedAt = deps.now();
      const ended = new Promise<string>((resolve) => {
        child = spawn(deps.executable, ["server.js"], {
          cwd: join(deps.directory, "web"),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", (chunk) => void log(String(chunk)));
        child.stderr?.on("data", (chunk) => void log(String(chunk)));
        child.once("error", (error) =>
          resolve(`could not start (${error.message})`),
        );
        child.once("exit", (code, signal) =>
          resolve(
            signal ? `was ended by ${signal}` : `exited with code ${code}`,
          ),
        );
      });
      if (child?.pid !== undefined) await remember(child.pid);
      // Once it has run steadily, an earlier failure no longer stands.
      const steady = setTimeout(() => deps.notices.clear(DASHBOARD), STEADY_MS);
      const how = await ended;
      clearTimeout(steady);
      child = undefined;
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
  // Recorded with its start time, so a later rigd stops this very process and never another that reused its pid.
  const remember = async (pid: number) => {
    const startedAt = await processStartTime(pid);
    await writeFile(
      record,
      JSON.stringify({ pid, ...(startedAt ? { startedAt } : {}) }),
      { mode: 0o600 },
    ).catch(() => {});
  };
  return {
    url: `http://127.0.0.1:${deps.port}`,
    async start() {
      await stopLeftOver(record);
      running = loop();
    },
    async stop() {
      stopping.abort();
      const current = child;
      if (current && current.exitCode === null && current.signalCode === null)
        await terminate(current);
      await running;
      await writing;
    },
  };
}

/** SIGTERM, then SIGKILL once STOP_GRACE_MS has passed; resolves once it has exited. */
async function terminate(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

/** Stops the dashboard an earlier rigd recorded and left running (one that was killed), so it does not hold the port.
 * Only the very process recorded is stopped: its pid and start time must both match. */
async function stopLeftOver(record: string): Promise<void> {
  let recorded: ProcessRecord;
  try {
    recorded = JSON.parse(await readFile(record, "utf8")) as ProcessRecord;
  } catch {
    return;
  }
  if (
    Number.isInteger(recorded.pid) &&
    recorded.startedAt !== undefined &&
    (await recordedProcess(recorded)) === "running"
  ) {
    process.kill(recorded.pid, "SIGTERM");
    for (
      const until = Date.now() + STOP_GRACE_MS;
      Date.now() < until && (await recordedProcess(recorded)) === "running";
    )
      await Bun.sleep(100);
    if ((await recordedProcess(recorded)) === "running")
      process.kill(recorded.pid, "SIGKILL");
  }
  await rm(record, { force: true });
}
