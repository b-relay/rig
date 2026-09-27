import {
  clearCaptureStatus,
  DEFAULT_CAPTURE_START_MS,
  waitForCaptureStart,
} from "./capture-status";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { RigError, failureReason } from "../domain/errors";
import type {
  ManagedProcess,
  ProcessObservation,
  StopKill,
  StopRequest,
  StopResult,
  Supervisor,
  TargetLogEntry,
} from "./contracts";
import {
  CAPTURE_KILL_SIGNAL,
  readCaptureStop,
  removeCaptureStop,
} from "./capture-stop";
import { readCaptureRequest } from "./capture-request";
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
  writeExitRecord,
} from "./exit-record";
import { survivingApplication } from "./capture-observation";
import type { ProcessInspection } from "./process-inspection";
import type { ProcessTiming } from "./process-timing";
import { appendTargetLog } from "./target-log";
/** How often stop asks whether the signalled group is gone. */
const STOP_POLL_MS = 20;
const leaseSchema = z.object({
  key: z.string().describe("Stable component ownership key."),
  pid: z
    .number()
    .int()
    .min(2)
    .describe(
      "Owned process group leader; the group id equals this PID, so the group can outlive the leader.",
    ),
  identity: z
    .string()
    .length(64)
    .describe("Digest of immutable process birth time and PID."),
  incarnation: z
    .string()
    .optional()
    .describe(
      "The start that produced this process; absent on a lease written before starts were named.",
    ),
});
/** Appends one log line through the shared writer, which rotates a full log and recreates a removed directory. */
function recordLine(logRoot: string, entry: TargetLogEntry): Promise<void> {
  return appendTargetLog(logRoot, JSON.stringify(entry) + "\n");
}
/** Longest run of output characters recorded as one log record. */
const MAX_RECORD_CHARS = 64 * 1024;
interface OwnedProcess {
  pid: number;
  identity?: string;
  child?: ChildProcess;
  incarnation?: string;
  /** The grace its start asked for, which `shutdown` gives it; absent for a process recovered from its lease. */
  graceMs?: number;
  /** Settles once the child's exit is on disk, or could not be put there. */
  exitRecorded?: Promise<void>;
  drains: Promise<void>[];
  writes: Promise<void>;
  /** Why the latest output line could not be recorded; cleared by the next line that is. */
  outputFailure?: string;
}
export interface ChildSupervisorOptions {
  readonly stateRoot: string;
  /** The kill wait and wrapper headroom every stop budget adds to its grace; `PLATFORM_STOP_TIMINGS` when absent. */
  readonly stopTimings?: StopTimings;
  /** Clock and timers; `createProcessTiming()` on the platform, scripted in tests. */
  readonly timing: ProcessTiming;
  /** Process identity, group presence, and signals; the owner passes the platform's or a scripted one. */
  readonly processInspection: ProcessInspection;
  readonly captureCommand?: readonly string[];
}
/** Daemon-owned groups have identity-checked leases; stop never trusts an unverified recovered PID.
 * A process is started once and never respawned here. Whoever holds the application's child handle records its exit:
 * this supervisor, or under a capture command the wrapper's own, whose records this one then reads. */
export function createChildSupervisor(
  options: ChildSupervisorOptions,
): Supervisor {
  const processes = new Map<string, OwnedProcess>();
  const operations = new Map<string, Promise<unknown>>();
  const timing = options.timing;
  const now = timing.now;
  const inspection = options.processInspection;
  const inspect = inspection.identity;
  const leaseRoot = join(options.stateRoot, "process-leases");
  const captureRoot = join(options.stateRoot, "capture");
  /** Where the holder of the application's child handle records exits. */
  const exitRoot = options.captureCommand ? captureRoot : options.stateRoot;
  /** Where this supervisor records how a capture wrapper it spawned ended. */
  const wrapperExitRoot = join(captureRoot, "wrapper");
  const capturePath = (key: string) =>
    join(captureRoot, `${createHash("sha256").update(key).digest("hex")}.json`);
  /** What a start whose process is gone left behind. Under capture, an application the wrapper reported that still runs is
   * `unknown`, unless `survivors` is `ignore`; the application's own exit record comes first, then this supervisor's
   * record of how the wrapper ended. */
  const stoppedObservation = async (
    key: string,
    survivors: "check" | "ignore",
  ): Promise<ProcessObservation> => {
    if (!options.captureCommand)
      return {
        state: "stopped",
        ...exitEvidence(await readExitRecord(exitRoot, key)),
      };
    if (survivors === "check") {
      const survivor = await survivingApplication({
        requestPath: capturePath(key),
        inspect,
      });
      if (survivor) return survivor;
    }
    const recorded = exitEvidence(await readExitRecord(exitRoot, key));
    if (recorded) return { state: "stopped", ...recorded };
    const wrapper = await readExitRecord(wrapperExitRoot, key);
    const ended = wrapper && wrapperExitEvidence(wrapper);
    return {
      state: "stopped",
      ...(ended
        ? {
            incarnation: wrapper!.incarnation,
            ...ended,
            recordedBy: "rigd" as const,
          }
        : {}),
    };
  };
  const removeExitRecords = async (key: string) => {
    await removeExitRecord(exitRoot, key);
    if (options.captureCommand) await removeExitRecord(wrapperExitRoot, key);
  };
  const leasePath = (key: string) =>
    join(leaseRoot, `${createHash("sha256").update(key).digest("hex")}.json`);
  function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
    const pending = (operations.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    operations.set(key, pending);
    void pending
      .finally(() => {
        if (operations.get(key) === pending) operations.delete(key);
      })
      .catch(() => {});
    return pending;
  }
  async function recover(key: string): Promise<OwnedProcess | undefined> {
    const existing = processes.get(key);
    if (existing) return existing;
    let raw: string;
    try {
      raw = await readFile(leasePath(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = leaseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.key !== key)
      throw new RigError(
        "PROCESS_LEASE",
        "The recorded process lease is invalid.",
        "Inspect the daemon state before retrying.",
        { key },
      );
    const current = await inspect(parsed.data.pid);
    // A dead leader whose group still runs is still ours: the group id stays reserved while any member lives.
    if (current !== parsed.data.identity)
      if (
        current !== undefined ||
        !(await inspection.groupExists(parsed.data.pid))
      )
        return undefined;
    const owned: OwnedProcess = {
      pid: parsed.data.pid,
      identity: parsed.data.identity,
      ...(parsed.data.incarnation
        ? { incarnation: parsed.data.incarnation }
        : {}),
      drains: [],
      writes: Promise.resolve(),
    };
    processes.set(key, owned);
    return owned;
  }
  async function observe(
    key: string,
    signal?: AbortSignal,
    survivors: "check" | "ignore" = "check",
  ): Promise<ProcessObservation> {
    if (signal?.aborted)
      return { state: "unknown", reason: "Observation cancelled." };
    let owned: OwnedProcess | undefined;
    try {
      owned = await recover(key);
    } catch {
      return {
        state: "unknown",
        reason: "Process ownership could not be verified.",
      };
    }
    if (signal?.aborted)
      return { state: "unknown", reason: "Observation cancelled." };
    if (!owned) return await stoppedObservation(key, survivors);
    const running = {
      state: "running" as const,
      pid: owned.pid,
      ...(owned.incarnation ? { incarnation: owned.incarnation } : {}),
    };
    if (
      owned.child &&
      (owned.child.exitCode !== null || owned.child.signalCode !== null)
    ) {
      await owned.exitRecorded;
      return await stoppedObservation(key, survivors);
    }
    // A spawned child's handle is authoritative: Bun reports its exit within milliseconds, so no OS probe second-guesses it.
    if (owned.child)
      return {
        ...running,
        ...(owned.outputFailure ? { reason: owned.outputFailure } : {}),
      };
    try {
      if ((await inspect(owned.pid)) === owned.identity) return running;
      return await stoppedObservation(key, survivors);
    } catch {
      return {
        state: "unknown",
        reason: "Process ownership could not be verified.",
      };
    }
  }
  /** SIGTERM to the owned group, then SIGKILL once its wait is over, then the kill wait. The wait is the grace for a plain
   * process, and for a capture wrapper the wrapper's whole budget, since the wrapper holds its application's grace itself:
   * it is never killed before that grace and the application's kill wait can finish. A kill cuts the wait short: a plain
   * process is killed after the kill wait, a wrapper that understands it is told to kill its application now. Returns
   * how the group ended; fails STOP_DETACHED as soon as `detach` aborts, leaving the group owned and stopping. */
  async function signalUntilGone(
    key: string,
    pid: number,
    request: StopRequest,
  ): Promise<StopKill | undefined> {
    if (request.detach?.aborted) throw stopDetached({ key });
    // A wrapper holds the grace its start was given, which may be longer than the one asked for now (a plan changed in
    // between): it is never cut off before that grace can finish.
    const captured = options.captureCommand
      ? await readCaptureRequest(capturePath(key)).catch(() => undefined)
      : undefined;
    const budget = stopBudget(
      Math.max(request.graceMs, captured?.stopGraceMs ?? 0),
      options.stopTimings ?? PLATFORM_STOP_TIMINGS,
    );
    const started = now().getTime();
    const graceEnd =
      started + (options.captureCommand ? budget.wrapperMs : budget.graceMs);
    const afterKill = options.captureCommand
      ? budget.killedWrapperMs
      : budget.killWaitMs;
    let killAskedAt: number | undefined;
    const deadline = () =>
      killAskedAt === undefined
        ? graceEnd
        : Math.min(graceEnd, killAskedAt + afterKill);
    await inspection.signalGroup(pid, "SIGTERM");
    while (
      (await inspection.groupExists(pid)) &&
      now().getTime() < deadline()
    ) {
      if (request.detach?.aborted) throw stopDetached({ key });
      // A wrapper written by an older rigd cannot be told to kill; it is left to its own short grace instead.
      if (
        request.kill?.aborted &&
        killAskedAt === undefined &&
        (!options.captureCommand || captured?.stopGraceMs !== undefined)
      ) {
        killAskedAt = now().getTime();
        // The wrapper alone: its group also holds the inspection helpers it runs.
        if (options.captureCommand)
          await inspection.signalProcess(pid, CAPTURE_KILL_SIGNAL);
      }
      await timing.wait(STOP_POLL_MS);
    }
    let killed: StopKill | undefined;
    if (await inspection.groupExists(pid)) {
      await inspection.signalGroup(pid, "SIGKILL");
      killed =
        killAskedAt !== undefined && killAskedAt + afterKill <= graceEnd
          ? "request"
          : "timeout";
    }
    const killDeadline = now().getTime() + budget.killWaitMs;
    while (
      (await inspection.groupExists(pid)) &&
      now().getTime() < killDeadline
    )
      await timing.wait(STOP_POLL_MS);
    if (await inspection.groupExists(pid))
      throw new RigError(
        "STOP_TIMEOUT",
        "The process group did not stop.",
        "Inspect the Target process before retrying.",
        { key },
      );
    return killed;
  }
  async function stop(key: string, request: StopRequest): Promise<StopResult> {
    const owned = await recover(key);
    if (!owned) return { outcome: "unchanged" };
    // An application that outlived its wrapper is not this stop's to end: the stop releases only what it owns.
    const before = await observe(key, undefined, "ignore");
    if (before.state === "unknown")
      throw new RigError(
        "PROCESS_UNKNOWN",
        "Process ownership could not be verified.",
        "Inspect daemon state before stopping this component.",
        { key },
      );
    // Live children are held by this daemon; recovered PIDs require a fresh identity check before any signal.
    const liveChild =
      owned.child &&
      owned.child.exitCode === null &&
      owned.child.signalCode === null;
    const currentIdentity = liveChild
      ? owned.identity
      : await inspect(owned.pid);
    // A gone leader (undefined identity) leaves only our group members behind, so a surviving group is still ours to signal.
    const verified =
      Boolean(liveChild) ||
      (owned.child
        ? currentIdentity === undefined || currentIdentity === owned.identity
        : currentIdentity === owned.identity ||
          (currentIdentity === undefined &&
            (await inspection.groupExists(owned.pid))));
    let killed = verified
      ? await signalUntilGone(key, owned.pid, request)
      : undefined;
    await Promise.all(owned.drains);
    await owned.writes;
    await owned.exitRecorded;
    await rm(leasePath(key), { force: true });
    if (options.captureCommand) {
      // A wrapper that had to kill its application said so before it ended.
      killed ??= await readCaptureStop(capturePath(key));
      await removeCaptureStop(capturePath(key));
      await rm(capturePath(key), { force: true });
    }
    // Ending a running process was a request, not an exit to explain; an exit that came first stays on record,
    // which is how the capture wrapper's own cleanup leaves its application's exit readable.
    if (before.state === "running") await removeExitRecords(key);
    return before.state === "running"
      ? { outcome: "stopped", ...(killed ? { killed } : {}) }
      : { outcome: "unchanged" };
  }
  /** Waits for in-flight operations so ownership can be handed over or ended. */
  async function quiesce(): Promise<void> {
    await Promise.all(
      [...operations.values()].map((pending) => pending.catch(() => {})),
    );
  }
  async function ensureRunning(
    request: ManagedProcess,
  ): Promise<{ outcome: "started" | "unchanged"; pid?: number }> {
    const observed = await observe(request.key);
    if (observed.state === "running")
      return { outcome: "unchanged", pid: observed.pid };
    if (observed.state === "unknown")
      throw new RigError(
        "PROCESS_UNKNOWN",
        "The existing process could not be inspected.",
        "Resolve process ownership before starting it.",
        { key: request.key },
      );
    if (processes.has(request.key))
      await stop(request.key, { graceMs: graceOf(request) });
    if (!request.command.length)
      throw new RigError(
        "COMMAND_EMPTY",
        "The managed component has no command.",
        "Configure a command.",
        { key: request.key },
      );
    // A record left by an earlier start must not explain the end of this one.
    await removeExitRecords(request.key);
    await mkdir(request.logRoot, { recursive: true });
    await mkdir(leaseRoot, { recursive: true });
    await appendFile(join(request.logRoot, "target.jsonl"), "", {
      mode: 0o600,
    });
    let command = request.command;
    if (options.captureCommand) {
      await mkdir(captureRoot, { recursive: true });
      await clearCaptureStatus(capturePath(request.key));
      const temporary = `${capturePath(request.key)}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(request), { mode: 0o600 });
        await rename(temporary, capturePath(request.key));
      } finally {
        await rm(temporary, { force: true });
      }
      command = [...options.captureCommand, capturePath(request.key)];
    }
    let child: ChildProcess;
    try {
      child = spawn(command[0]!, [...command.slice(1)], {
        cwd: request.cwd,
        env: request.env,
        detached: true,
        stdio: options.captureCommand ? "ignore" : ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new RigError(
        "PROCESS_START",
        "The managed component could not start.",
        "Check its executable and working directory.",
        { key: request.key },
      );
    }
    const owned: OwnedProcess = {
      pid: 0,
      child,
      incarnation: request.incarnation,
      graceMs: graceOf(request),
      drains: [],
      writes: Promise.resolve(),
    };
    // An exit that cannot be written stays unknown: nothing is remembered that a later daemon could not also read.
    const recordExit = (
      root: string,
      code: number | null,
      signal: NodeJS.Signals | null,
    ) =>
      writeExitRecord(root, {
        key: request.key,
        incarnation: request.incarnation,
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
        at: now().toISOString(),
      }).catch(() => {});
    if (!options.captureCommand)
      child.once("exit", (code, signal) => {
        owned.exitRecorded = recordExit(exitRoot, code, signal);
      });
    // Under a capture command this child is the wrapper. Its own end is kept apart from its application's record and read only
    // when that record is missing; settling once it is on disk lets a stop remove it after the wrapper has gone.
    else
      owned.exitRecorded = new Promise((resolve) =>
        child.once("exit", (code, signal) =>
          resolve(recordExit(wrapperExitRoot, code, signal)),
        ),
      );
    if (!options.captureCommand) captureOutput(owned, request, now);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) =>
        reject(
          new RigError(
            "PROCESS_START",
            "The managed component could not start.",
            "Check its executable and working directory.",
            { key: request.key, cause: error.message },
          ),
        ),
      );
    });
    owned.pid = child.pid!;
    processes.set(request.key, owned);
    try {
      owned.identity = await inspect(owned.pid);
      if (owned.identity) {
        const temporary = `${leasePath(request.key)}.${randomUUID()}.tmp`;
        try {
          await writeFile(
            temporary,
            JSON.stringify({
              key: request.key,
              pid: owned.pid,
              identity: owned.identity,
              incarnation: request.incarnation,
            }),
            { mode: 0o600 },
          );
          await rename(temporary, leasePath(request.key));
        } finally {
          await rm(temporary, { force: true });
        }
      }
      if (options.captureCommand)
        await waitForCaptureStart(capturePath(request.key), {
          timeoutMs: DEFAULT_CAPTURE_START_MS,
          now: () => timing.now().getTime(),
          wait: (ms) => timing.wait(ms),
        });
    } catch (error) {
      await stop(request.key, { graceMs: graceOf(request) });
      throw error;
    }
    return { outcome: "started", pid: child.pid };
  }
  return {
    ensureRunning: (request) =>
      serialized(request.key, () => ensureRunning(request)),
    observe,
    stop: (key, request) => serialized(key, () => stop(key, request)),
    async shutdown() {
      await quiesce();
      await Promise.all(
        [...processes].map(([key, owned]) =>
          stop(key, { graceMs: owned.graceMs ?? serviceGraceMs(undefined) }),
        ),
      );
    },
    async detach() {
      await quiesce();
      for (const owned of processes.values()) {
        owned.child?.removeAllListeners("exit");
        owned.child?.unref();
      }
      processes.clear();
    },
  };
}
/** The grace a start asked for, or the default for a request that names none. */
function graceOf(request: ManagedProcess): number {
  return request.stopGraceMs ?? serviceGraceMs(undefined);
}
function captureOutput(
  owned: OwnedProcess,
  request: ManagedProcess,
  now: () => Date,
): void {
  for (const stream of ["stdout", "stderr"] as const) {
    const pipe = owned.child![stream]!;
    owned.drains.push(
      new Promise((resolve) => {
        const decoder = new StringDecoder("utf8");
        let pending = "";
        // A newline-free run is recorded in bounded pieces: after JSON escaping
        // (up to 6 characters per control byte) each stays far below the 4 MiB
        // window the log reader can take in one read.
        const emit = (text: string) => {
          if (text.length <= MAX_RECORD_CHARS) return record(text);
          for (let at = 0; at < text.length; at += MAX_RECORD_CHARS)
            record(text.slice(at, at + MAX_RECORD_CHARS));
        };
        const record = (line: string) => {
          const entry: TargetLogEntry = {
            timestamp: now().toISOString(),
            component: request.componentName,
            stream,
            line,
          };
          owned.writes = owned.writes
            .then(() => recordLine(request.logRoot, entry))
            .then(
              () => {
                owned.outputFailure = undefined;
              },
              (error) => {
                owned.outputFailure = `Target output is not being recorded in ${request.logRoot}: ${failureReason(error)}`;
              },
            );
        };
        pipe.on("data", (chunk: Buffer) => {
          pending += decoder.write(chunk);
          let newline: number;
          while ((newline = pending.indexOf("\n")) !== -1) {
            emit(pending.slice(0, newline).replace(/\r$/, ""));
            pending = pending.slice(newline + 1);
          }
          if (pending.length > MAX_RECORD_CHARS) {
            emit(pending);
            pending = "";
          }
        });
        pipe.once("end", () => {
          pending += decoder.end();
          if (pending) emit(pending);
          resolve();
        });
        pipe.once("error", () => resolve());
      }),
    );
  }
}
