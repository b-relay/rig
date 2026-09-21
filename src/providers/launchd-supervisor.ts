import { readCaptureObservation } from "./capture-observation";
import type { ProcessIdentityReader } from "./process-identity";
import {
  clearCaptureStatus,
  DEFAULT_CAPTURE_START_MS,
  waitForCaptureStart,
} from "./capture-status";
import { writeCaptureRequest } from "./capture-request";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RigError } from "../domain/errors";
import type {
  CommandRunner,
  ManagedProcess,
  ProcessObservation,
  Supervisor,
} from "./contracts";
import { DEFAULT_SHUTDOWN_BUDGET_MS } from "./child-supervisor";
import { exitEvidence, readExitRecord, removeExitRecord } from "./exit-record";
export interface LaunchdOptions {
  readonly root: string;
  readonly domain: string;
  readonly labelPrefix: string;
  /** Runs `launchctl`; the platform runner in rigd, a fake in tests. */
  readonly run: CommandRunner;
  /** Fresh process birth identity checks for captured wrapper and application ownership; the daemon shares its identity reader. */
  readonly inspect: ProcessIdentityReader;
  /** Clock, pauses, and wait budgets; `createLaunchdTiming()` on the platform, scripted in tests. */
  readonly timing: LaunchdTiming;
  /** rigd's private capture command, used to timestamp and separate both application streams. */
  readonly captureCommand?: readonly string[];
}
/** The clock this supervisor polls by and how long each wait may run on it; the platform implementation is the effect owner, a test supplies a scripted one. */
export interface LaunchdTiming {
  /** Unix milliseconds; rejects stale capture observations and bounds every poll below. */
  now(): number;
  /** Resolves once `ms` have elapsed on the same clock; every poll pause in this supervisor uses it. */
  wait(ms: number): Promise<void>;
  /** How long a launchd application may take to appear after bootstrap or after its advertised restart. */
  readonly applicationStartMs: number;
  /** How long a booted-out job may take to leave launchd before stop fails as LAUNCHD_STOP. */
  readonly unloadBudgetMs: number;
}
/** Application start budget on the platform. */
export const DEFAULT_APPLICATION_START_MS = 3000;
/** The wrapper's own SIGTERM then SIGKILL shutdown, plus headroom for output drains and launchctl latency. */
export const DEFAULT_UNLOAD_BUDGET_MS = DEFAULT_SHUTDOWN_BUDGET_MS + 2000;
export function createLaunchdTiming(): LaunchdTiming {
  return {
    now: Date.now,
    wait: (ms) => Bun.sleep(ms),
    applicationStartMs: DEFAULT_APPLICATION_START_MS,
    unloadBudgetMs: DEFAULT_UNLOAD_BUDGET_MS,
  };
}
/** Polling cadence for the application start and unload waits. */
const POLL_MS = 100;
/** launchd keeps a job alive across rigd's exit but never respawns it (KeepAlive is false): whether a Service that ended
 * starts again is the runtime's decision. Explicit up preserves already running jobs. */
export function createLaunchdSupervisor(options: LaunchdOptions): Supervisor {
  const { run, inspect } = options;
  const { now, wait, applicationStartMs, unloadBudgetMs } = options.timing;
  const label = (key: string) =>
    `${options.labelPrefix}.${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  const service = (key: string) => `${options.domain}/${label(key)}`;
  const checked = async (args: readonly string[], key: string) => {
    const result = await run({ command: ["launchctl", ...args] });
    if (result.exitCode !== 0)
      throw new RigError(
        "LAUNCHD_FAILED",
        `launchd could not ${args[0]} job ${label(key)}.`,
        "Check daemon diagnostics and the Target logs.",
        {
          action: args[0],
          label: label(key),
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      );
    return result;
  };
  /** Every file this supervisor writes for a job: plist, request, and the wrapper's status and observation evidence. */
  const removeJobFiles = async (key: string) => {
    const requestPath = join(options.root, `${label(key)}.json`);
    for (const file of [
      join(options.root, `${label(key)}.plist`),
      requestPath,
      `${requestPath}.status.json`,
      `${requestPath}.observation.json`,
    ])
      await rm(file, { force: true });
    await removeExitRecord(options.root, key);
  };
  const unloaded = (result: { exitCode: number; stderr: string }) =>
    result.exitCode !== 0 &&
    /could not find service|service not found/i.test(result.stderr);
  const observe = async (
    key: string,
    signal?: AbortSignal,
  ): Promise<ProcessObservation> => {
    if (signal?.aborted)
      return { state: "unknown", reason: "Observation cancelled." };
    try {
      const result = await run({
        command: ["launchctl", "print", service(key)],
        signal,
        timeoutMs: 2000,
      });
      if (result.exitCode !== 0 && !unloaded(result))
        return {
          state: "unknown",
          reason: "launchd could not inspect the job.",
        };
      const pid = result.stdout.match(/^\s*pid = (\d+)\s*$/m);
      if (pid)
        return options.captureCommand
          ? await readCaptureObservation({
              requestPath: join(options.root, `${label(key)}.json`),
              wrapperPid: Number(pid[1]),
              inspect,
              now,
              signal,
            })
          : { state: "running", pid: Number(pid[1]) };
      // Loaded without a pid, or no longer loaded. launchd's own last exit code names no start and, under capture, is
      // the wrapper's; only the wrapper's record of its application's exit is evidence.
      return {
        state: "stopped",
        ...exitEvidence(await readExitRecord(options.root, key)),
      };
    } catch {
      return {
        state: "unknown",
        reason: signal?.aborted
          ? "Observation cancelled."
          : "launchd observation failed.",
      };
    }
  };
  /** Waits up to applicationStartMs for the application to run. */
  const waitForApplication = async (
    key: string,
  ): Promise<number | undefined> => {
    const deadline = now() + applicationStartMs;
    let last: ProcessObservation | undefined;
    do {
      last = await observe(key);
      if (last.state === "running") return last.pid;
      await wait(POLL_MS);
    } while (now() < deadline);
    throw new RigError(
      "LAUNCHD_START",
      "The managed job did not start.",
      "Inspect the Target logs and retry.",
      {
        key,
        ...(last?.exitCode === undefined ? {} : { exitCode: last.exitCode }),
      },
    );
  };
  return {
    observe,
    async ensureRunning(request) {
      const before = await observe(request.key);
      if (before.state === "running")
        return { outcome: "unchanged", pid: before.pid };
      if (before.state === "unknown")
        throw new RigError(
          "LAUNCHD_UNKNOWN",
          "The existing job could not be inspected.",
          "Resolve launchd access before starting it.",
          { key: request.key },
        );
      // A record left by an earlier start must not explain the end of this one.
      await removeExitRecord(options.root, request.key);
      await mkdir(options.root, { recursive: true });
      await mkdir(request.logRoot, { recursive: true });
      const jobLabel = label(request.key);
      const requestPath = join(options.root, `${jobLabel}.json`);
      let command = request.command;
      if (options.captureCommand) {
        await clearCaptureStatus(requestPath);
        await writeCaptureRequest(requestPath, request);
        command = [...options.captureCommand, requestPath];
      }
      const plist = join(options.root, `${jobLabel}.plist`);
      await writeFile(plist, launchdPlist({ ...request, command }, jobLabel), {
        mode: 0o600,
      });
      const existing = await run({
        command: ["launchctl", "print", service(request.key)],
        timeoutMs: 2000,
      });
      try {
        if (existing.exitCode === 0)
          await checked(["bootout", service(request.key)], request.key);
        await checked(["bootstrap", options.domain, plist], request.key);
      } catch (error) {
        await removeJobFiles(request.key);
        throw error;
      }
      if (options.captureCommand) {
        try {
          await waitForCaptureStart(requestPath, {
            timeoutMs: DEFAULT_CAPTURE_START_MS,
            now,
            wait,
          });
        } catch (error) {
          await checked(["bootout", service(request.key)], request.key);
          await removeJobFiles(request.key);
          throw error;
        }
      }
      return { outcome: "started", pid: await waitForApplication(request.key) };
    },
    async stop(key) {
      const existing = await run({
        command: ["launchctl", "print", service(key)],
        timeoutMs: 2000,
      });
      if (existing.exitCode !== 0) {
        if (unloaded(existing)) {
          await removeJobFiles(key);
          return { outcome: "unchanged" };
        }
        throw new RigError(
          "LAUNCHD_UNKNOWN",
          "The existing job could not be inspected.",
          "Resolve launchd access before stopping it.",
          { key },
        );
      }
      await checked(["bootout", service(key)], key);
      const deadline = now() + unloadBudgetMs;
      do {
        const result = await run({
          command: ["launchctl", "print", service(key)],
          timeoutMs: 2000,
        });
        if (unloaded(result)) {
          await removeJobFiles(key);
          return { outcome: "stopped" };
        }
        await wait(POLL_MS);
      } while (now() < deadline);
      throw new RigError(
        "LAUNCHD_STOP",
        `The managed job ${label(key)} did not unload within ${unloadBudgetMs / 1000} s.`,
        "Inspect launchd state, then run the stop again once the job is gone.",
        { key, label: label(key) },
      );
    },
    async shutdown() {
      /* Persistent jobs remain owned by launchd when the daemon exits. */
    },
    async detach() {
      /* launchd keeps the jobs; nothing is held in memory. */
    },
  };
}
function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function launchdPlist(request: ManagedProcess, label: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${request.command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(request.cwd)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(
    request.env,
  )
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join(
      "",
    )}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><false/>\n<key>StandardOutPath</key><string>${xml(join(request.logRoot, `${request.componentName}.stdout.log`))}</string>\n<key>StandardErrorPath</key><string>${xml(join(request.logRoot, `${request.componentName}.stderr.log`))}</string>\n</dict></plist>\n`;
}
