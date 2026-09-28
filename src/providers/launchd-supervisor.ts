import {
  readCaptureObservation,
  survivingApplication,
} from "./capture-observation";
import { parseLaunchdJobExit } from "./launchd-job-exit";
import type { ProcessIdentityReader } from "./process-identity";
import {
  clearCaptureStatus,
  DEFAULT_CAPTURE_START_MS,
  waitForCaptureStart,
} from "./capture-status";
import { readCaptureRequest, writeCaptureRequest } from "./capture-request";
import { rotateLogFile } from "./target-log";
import {
  DEFAULT_LOG_RETENTION,
  type LogRetention,
} from "../domain/log-retention";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RigError } from "../domain/errors";
import type {
  CommandRunner,
  ManagedProcess,
  ProcessObservation,
  StopKill,
  StopRequest,
  Supervisor,
} from "./contracts";
import {
  CAPTURE_KILL_SIGNAL,
  readCaptureStop,
  removeCaptureStop,
} from "./capture-stop";
import {
  PLATFORM_STOP_TIMINGS,
  serviceGraceMs,
  stopBudget,
  stopDetached,
  type StopTimings,
} from "../domain/stop-budget";
import {
  exitEvidence,
  readExitRecord,
  removeExitRecord,
  wrapperExitEvidence,
} from "./exit-record";
export interface LaunchdOptions {
  readonly root: string;
  readonly domain: string;
  readonly labelPrefix: string;
  /** Runs `launchctl`; the platform runner in rigd, a fake in tests. */
  readonly run: CommandRunner;
  /** Fresh process birth identity checks for captured wrapper and application ownership; the daemon shares its identity reader. */
  readonly inspect: ProcessIdentityReader;
  /** Whether a process group still has members; decides whether an application outlived its capture wrapper once the
   * group's leader is gone. The daemon shares its process inspection's probe. */
  readonly groupExists: (pid: number) => Promise<boolean>;
  /** Clock, pauses, and wait budgets; `createLaunchdTiming()` on the platform, scripted in tests. */
  readonly timing: LaunchdTiming;
  /** rigd's private capture command, used to timestamp and separate both application streams. */
  readonly captureCommand?: readonly string[];
  /** Reads how the files launchd writes for a job are rotated, before each start; the default when absent. */
  readonly logRetention?: () => Promise<LogRetention>;
  /** The Rig root whose config.yaml logs settings the capture wrappers of these jobs rotate the Target log by; absent,
   * they use the defaults. */
  readonly configRoot?: string;
}
/** The clock this supervisor polls by and how long each wait may run on it; the platform implementation is the effect owner, a test supplies a scripted one. */
export interface LaunchdTiming {
  /** Unix milliseconds; rejects stale capture observations and bounds every poll below. */
  now(): number;
  /** Resolves once `ms` have elapsed on the same clock; every poll pause in this supervisor uses it. */
  wait(ms: number): Promise<void>;
  /** How long a launchd application may take to appear after bootstrap or after its advertised restart. */
  readonly applicationStartMs: number;
  /** The kill wait and headroom each stop budget adds to a Service's grace: they size the plist's ExitTimeOut and how long
   * a booted-out job may take to leave launchd before stop fails as LAUNCHD_STOP. */
  readonly stopTimings: StopTimings;
}
/** Application start budget on the platform. */
export const DEFAULT_APPLICATION_START_MS = 3000;
export function createLaunchdTiming(): LaunchdTiming {
  return {
    now: Date.now,
    wait: (ms) => Bun.sleep(ms),
    applicationStartMs: DEFAULT_APPLICATION_START_MS,
    stopTimings: PLATFORM_STOP_TIMINGS,
  };
}
/** Polling cadence for the application start and unload waits. */
const POLL_MS = 100;
/** launchd keeps a job alive across rigd's exit but never respawns it (KeepAlive is false): whether a Service that ended
 * starts again is the runtime's decision. Explicit up preserves already running jobs. */
export function createLaunchdSupervisor(options: LaunchdOptions): Supervisor {
  const { run, inspect, groupExists } = options;
  const { now, wait, applicationStartMs, stopTimings } = options.timing;
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
  /** Every file this supervisor writes for a job: plist, request, and the wrapper's status and observation evidence. The
   * observation stays while the application it names outlives its wrapper (or cannot be shown not to), so that application
   * keeps reading as `unknown` and no start is made beside it after the job is gone. */
  const removeJobFiles = async (key: string) => {
    const requestPath = join(options.root, `${label(key)}.json`);
    const survivor =
      options.captureCommand &&
      (await survivingApplication({ requestPath, key, inspect, groupExists }));
    await removeCaptureStop(requestPath);
    for (const file of [
      join(options.root, `${label(key)}.plist`),
      requestPath,
      `${requestPath}.status.json`,
      ...(survivor ? [] : [`${requestPath}.observation.json`]),
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
      // Loaded without a pid, or no longer loaded: the wrapper is gone. An application it reported that still runs is not
      // stopped, and a start is never made beside it.
      const requestPath = join(options.root, `${label(key)}.json`);
      if (options.captureCommand) {
        const survivor = await survivingApplication({
          requestPath,
          key,
          inspect,
          groupExists,
        });
        if (survivor) return survivor;
      }
      // The wrapper's record of its application's exit comes first; without it, launchd's record of how the wrapper ended.
      const recorded = exitEvidence(await readExitRecord(options.root, key));
      return {
        state: "stopped",
        ...(recorded ??
          (result.exitCode === 0 && options.captureCommand
            ? await jobEvidence(requestPath, result.stdout)
            : {})),
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
  /** Polls until the booted-out job has left launchd: within the unload budget of its grace, or of its kill once one is
   * asked. A kill asks the capture wrapper to cut its application's grace short, or without a wrapper SIGKILLs the job after
   * the kill wait. Returns why the application needed SIGKILL, as its wrapper recorded it; fails STOP_DETACHED as soon as
   * `detach` aborts and LAUNCHD_STOP when the budget runs out. */
  const awaitUnload = async (
    key: string,
    request: StopRequest,
  ): Promise<StopKill | undefined> => {
    const requestPath = join(options.root, `${label(key)}.json`);
    // The job's ExitTimeOut and its wrapper's grace were set from the grace its start was given, which may be longer than
    // the one asked for now: the wait covers it.
    const startedGrace = options.captureCommand
      ? (await readCaptureRequest(requestPath).catch(() => undefined))
          ?.stopGraceMs
      : undefined;
    const budget = stopBudget(
      Math.max(request.graceMs, startedGrace ?? 0),
      stopTimings,
    );
    const started = now();
    let deadline = started + budget.unloadMs;
    let killAskedAt: number | undefined;
    let killSent = false;
    do {
      if (request.detach?.aborted) throw stopDetached({ key });
      // A wrapper written by an older rigd cannot be told to kill; it is left to its own short grace instead.
      if (
        request.kill?.aborted &&
        killAskedAt === undefined &&
        (!options.captureCommand || startedGrace !== undefined)
      ) {
        killAskedAt = now();
        if (!options.captureCommand)
          deadline = Math.min(
            deadline,
            killAskedAt + budget.killedWrapperMs + budget.killWaitMs,
          );
      }
      // The wrapper cuts its application's grace short only once it has the signal: until launchctl delivered it the
      // original deadline stands, and each poll asks again.
      if (options.captureCommand && killAskedAt !== undefined && !killSent) {
        const sent = await run({
          command: ["launchctl", "kill", CAPTURE_KILL_SIGNAL, service(key)],
          timeoutMs: 2000,
        });
        if (sent.exitCode === 0 && !sent.timedOut) {
          killSent = true;
          deadline = Math.min(
            deadline,
            now() + budget.killedWrapperMs + budget.killWaitMs,
          );
        }
      }
      if (
        !killSent &&
        !options.captureCommand &&
        killAskedAt !== undefined &&
        now() >= killAskedAt + budget.killWaitMs
      ) {
        await run({
          command: ["launchctl", "kill", "SIGKILL", service(key)],
          timeoutMs: 2000,
        });
        killSent = true;
      }
      const result = await run({
        command: ["launchctl", "print", service(key)],
        timeoutMs: 2000,
      });
      if (unloaded(result))
        return options.captureCommand
          ? await readCaptureStop(requestPath)
          : killSent
            ? "request"
            : // Without a wrapper, a job still there at its ExitTimeOut was SIGKILLed by launchd.
              now() - started >= budget.exitTimeOutSeconds * 1000
              ? "timeout"
              : undefined;
      await wait(POLL_MS);
    } while (now() < deadline);
    throw new RigError(
      "LAUNCHD_STOP",
      `The managed job ${label(key)} did not unload within ${Math.round((deadline - started) / 100) / 10} s.`,
      "Inspect launchd state, then run the stop again once the job is gone.",
      { key, label: label(key) },
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
      // The ended job leaves launchd before the new request names this start, so launchd's record of the earlier wrapper is
      // never read as this start's end.
      const existing = await run({
        command: ["launchctl", "print", service(request.key)],
        timeoutMs: 2000,
      });
      try {
        if (existing.exitCode === 0)
          await checked(["bootout", service(request.key)], request.key);
      } catch (error) {
        await removeJobFiles(request.key);
        throw error;
      }
      // A record left by an earlier start must not explain the end of this one.
      await removeExitRecord(options.root, request.key);
      await mkdir(options.root, { recursive: true });
      await mkdir(request.logRoot, { recursive: true });
      const retention =
        (await options.logRetention?.()) ?? DEFAULT_LOG_RETENTION;
      await rotateJobLogs(request, retention);
      const jobLabel = label(request.key);
      const requestPath = join(options.root, `${jobLabel}.json`);
      let command = request.command;
      if (options.captureCommand) {
        await clearCaptureStatus(requestPath);
        await writeCaptureRequest(requestPath, request, options.configRoot);
        command = [...options.captureCommand, requestPath];
      }
      const plist = join(options.root, `${jobLabel}.plist`);
      // launchd waits ExitTimeOut after its SIGTERM before it kills the job: long enough for the wrapper to give its
      // application the whole grace and still end on its own.
      const exitTimeOut = stopBudget(
        request.stopGraceMs ?? serviceGraceMs(undefined),
        stopTimings,
      ).exitTimeOutSeconds;
      await writeFile(
        plist,
        launchdPlist({ ...request, command }, jobLabel, exitTimeOut),
        { mode: 0o600 },
      );
      try {
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
    async stop(key, request) {
      if (request.detach?.aborted) throw stopDetached({ key });
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
      // launchd sends SIGTERM and returns at once; a job already booted out gets SIGTERM again, which its wrapper ignores.
      // A bootout that fails or hangs while the job is still there (one a previous daemon began booting out) is waited
      // on like any other: the unload wait, its kill and its detach decide what happens next. A kill or a detach asked
      // while bootout has not returned goes on at once rather than after launchctl's own timeout.
      const bootout = await untilAborted(
        run({
          command: ["launchctl", "bootout", service(key)],
          timeoutMs: 10_000,
        }),
        [request.kill, request.detach],
      );
      if (request.detach?.aborted) throw stopDetached({ key });
      if (bootout && bootout.exitCode !== 0) {
        const still = await run({
          command: ["launchctl", "print", service(key)],
          timeoutMs: 2000,
        });
        if (still.exitCode !== 0 && !unloaded(still))
          throw new RigError(
            "LAUNCHD_FAILED",
            `launchd could not bootout job ${label(key)}.`,
            "Check daemon diagnostics and the Target logs.",
            {
              action: "bootout",
              label: label(key),
              exitCode: bootout.exitCode,
              stderr: bootout.stderr,
            },
          );
      }
      const killed = await awaitUnload(key, request);
      await removeJobFiles(key);
      return { outcome: "stopped", ...(killed ? { killed } : {}) };
    },
    async shutdown() {
      /* Persistent jobs remain owned by launchd when the daemon exits. */
    },
    async detach() {
      /* launchd keeps the jobs; nothing is held in memory. */
    },
  };
}
/** launchd's record of how the capture wrapper of the job's current plist ended, named by the start its request carries.
 * Each start boots out the job and bootstraps it again, so the record describes the latest start's wrapper; nothing is
 * evidence when the job never ended, ended with code 0 (see `wrapperExitEvidence`), or the request cannot be read. */
async function jobEvidence(
  requestPath: string,
  printed: string,
): Promise<
  | Pick<
      ProcessObservation,
      "incarnation" | "exitCode" | "signal" | "recordedBy"
    >
  | undefined
> {
  const ended = parseLaunchdJobExit(printed);
  const exit = ended && wrapperExitEvidence(ended);
  if (!exit) return undefined;
  const incarnation = await readCaptureRequest(requestPath).then(
    (request) => request.incarnation,
    () => undefined,
  );
  return incarnation === undefined
    ? undefined
    : { incarnation, ...exit, recordedBy: "launchd" };
}
/** launchd opens a job's stdout and stderr files when it starts the job and appends to them for as long as it runs, so
 * they rotate here, before each start, never under a running job. Housekeeping only: a file that cannot be rotated is
 * left to grow rather than stopping the start. */
async function rotateJobLogs(
  request: ManagedProcess,
  retention: LogRetention,
): Promise<void> {
  for (const stream of ["stdout", "stderr"])
    await rotateLogFile(
      join(request.logRoot, `${request.componentName}.${stream}.log`),
      retention,
    ).catch(() => {});
}
function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
/** The job's plist. `exitTimeOut` is how many seconds launchd waits after its SIGTERM before SIGKILL. */
function launchdPlist(
  request: ManagedProcess,
  label: string,
  exitTimeOut: number,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${request.command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(request.cwd)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(
    request.env,
  )
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join(
      "",
    )}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><false/>\n<key>ExitTimeOut</key><integer>${exitTimeOut}</integer>\n<key>StandardOutPath</key><string>${xml(join(request.logRoot, `${request.componentName}.stdout.log`))}</string>\n<key>StandardErrorPath</key><string>${xml(join(request.logRoot, `${request.componentName}.stderr.log`))}</string>\n</dict></plist>\n`;
}

/** `work`'s result, or undefined as soon as one of `signals` aborts first; `work` itself carries on unobserved. */
async function untilAborted<T>(
  work: Promise<T>,
  signals: readonly (AbortSignal | undefined)[],
): Promise<T | undefined> {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (present.some((signal) => signal.aborted)) {
    void work.catch(() => {});
    return undefined;
  }
  if (!present.length) return await work;
  const any = AbortSignal.any(present);
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    any.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    any.removeEventListener("abort", onAbort);
    void work.catch(() => {});
  }
}
