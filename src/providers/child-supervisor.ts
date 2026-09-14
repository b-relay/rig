import { clearCaptureStatus, waitForCaptureStart } from "./capture-status";
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
  Supervisor,
  TargetLogEntry,
} from "./contracts";
import {
  createProcessInspection,
  type ProcessInspection,
} from "./process-inspection";
import { createProcessTiming, type ProcessTiming } from "./process-timing";
/** SIGTERM grace before SIGKILL when no stopTimeoutMs is configured. */
const DEFAULT_STOP_TIMEOUT_MS = 1500;
/** How often stop asks whether the signalled group is gone. */
const STOP_POLL_MS = 20;
/** How long a killed process group may take to disappear when no killWaitMs is configured. */
const DEFAULT_KILL_WAIT_MS = 1500;
/** Worst-case shutdown of a supervisor with default timing, as the launchd capture wrapper runs it. */
export const DEFAULT_SHUTDOWN_BUDGET_MS =
  DEFAULT_STOP_TIMEOUT_MS + DEFAULT_KILL_WAIT_MS;
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
  request: z
    .object({
      key: z.string(),
      componentName: z.string(),
      command: z.array(z.string()),
      cwd: z.string(),
      env: z.record(z.string(), z.string()),
      logRoot: z.string(),
      keepAlive: z.boolean().optional(),
    })
    .optional()
    .describe(
      "The start request, so a daemon that adopts the lease can restart the process under its keepAlive policy.",
    ),
});
/** Appends one log line, bringing back a log directory that was removed underneath the running component. */
async function recordLine(logRoot: string, entry: TargetLogEntry): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  const file = join(logRoot, "target.jsonl");
  try {
    await appendFile(file, line, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(logRoot, { recursive: true });
    await appendFile(file, line, { mode: 0o600 });
  }
}
/** Longest run of output characters recorded as one log record. */
const MAX_RECORD_CHARS = 64 * 1024;
interface OwnedProcess {
  pid: number;
  identity?: string;
  child?: ChildProcess;
  request?: ManagedProcess;
  exitCode?: number;
  /** A recovered process has no child handle; its exit is noticed by observation and recorded once. */
  exitObserved?: boolean;
  stopped: boolean;
  drains: Promise<void>[];
  writes: Promise<void>;
  /** Why the latest output line could not be recorded; cleared by the next line that is. */
  outputFailure?: string;
}
export interface ChildSupervisorOptions {
  readonly stateRoot: string;
  /** SIGTERM grace before SIGKILL; 1500 ms, or 4000 ms under a capture wrapper. */
  readonly stopTimeoutMs?: number;
  /** How long a killed group may take to disappear before stop fails as STOP_TIMEOUT; 1500 ms. */
  readonly killWaitMs?: number;
  /** Clock and timers; the platform's unless a test scripts them. */
  readonly timing?: ProcessTiming;
  readonly processInspection?: ProcessInspection;
  readonly captureCommand?: readonly string[];
  readonly restartLimit?: number;
  readonly restartWindowMs?: number;
  readonly restartBackoffMs?: number;
}
/** Daemon-owned groups have identity-checked leases; stop never trusts an unverified recovered PID. */
export function createChildSupervisor(
  options: ChildSupervisorOptions,
): Supervisor {
  const processes = new Map<string, OwnedProcess>();
  const operations = new Map<string, Promise<unknown>>();
  const restarting = new Set<string>();
  const restarts = new Map<
    string,
    { times: number[]; cancel?: () => void; at?: number }
  >();
  /** Restart evidence for an observation: pending while a restart is scheduled or in flight, with its advertised time. */
  const restartEvidence = (key: string, owned: OwnedProcess) => {
    const restart = restarts.get(key);
    const pending = restarting.has(key) || (!owned.stopped && restart?.cancel);
    return pending
      ? { restartPending: true, ...(restart?.at === undefined ? {} : { restartAt: restart.at }) }
      : {};
  };
  const timing = options.timing ?? createProcessTiming();
  const now = timing.now;
  const inspection = options.processInspection ?? createProcessInspection();
  const inspect = inspection.identity;
  const leaseRoot = join(options.stateRoot, "process-leases");
  let shuttingDown = false;
  const captureRoot = join(options.stateRoot, "capture");
  const capturePath = (key: string) =>
    join(captureRoot, `${createHash("sha256").update(key).digest("hex")}.json`);
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
      if (current !== undefined || !(await inspection.groupExists(parsed.data.pid)))
        return undefined;
    const owned: OwnedProcess = {
      pid: parsed.data.pid,
      identity: parsed.data.identity,
      ...(parsed.data.request ? { request: parsed.data.request } : {}),
      stopped: false,
      drains: [],
      writes: Promise.resolve(),
    };
    processes.set(key, owned);
    return owned;
  }
  async function observe(
    key: string,
    signal?: AbortSignal,
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
    if (!owned) return { state: "stopped" };
    if (
      owned.child &&
      (owned.child.exitCode !== null || owned.child.signalCode !== null)
    )
      return {
        state: "stopped",
        ...(owned.exitCode === undefined ? {} : { exitCode: owned.exitCode }),
        ...restartEvidence(key, owned),
      };
    // A spawned child's handle is authoritative: Bun reports its exit within milliseconds and that report
    // schedules any restart, so no OS probe second-guesses it. A probe that ran between the reap and the
    // report answered "stopped" without restart evidence, which made the capture wrapper give up on a
    // keepAlive component.
    if (owned.child)
      return {
        state: "running",
        pid: owned.pid,
        ...(owned.outputFailure ? { reason: owned.outputFailure } : {}),
      };
    try {
      if ((await inspect(owned.pid)) === owned.identity)
        return { state: "running", pid: owned.pid };
      if (!owned.exitObserved) {
        owned.exitObserved = true;
        scheduleRestart(key, owned);
      }
      return { state: "stopped", ...restartEvidence(key, owned) };
    } catch {
      return {
        state: "unknown",
        reason: "Process ownership could not be verified.",
      };
    }
  }
  async function stop(
    key: string,
  ): Promise<{ outcome: "stopped" | "unchanged" }> {
    const restart = restarts.get(key);
    if (restart?.cancel) {
      restart.cancel();
      restart.cancel = undefined;
    }
    const owned = await recover(key);
    if (!owned) return { outcome: "unchanged" };
    const before = await observe(key);
    if (before.state === "unknown")
      throw new RigError(
        "PROCESS_UNKNOWN",
        "Process ownership could not be verified.",
        "Inspect daemon state before stopping this component.",
        { key },
      );
    owned.stopped = true;
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
    if (verified) {
      await inspection.signalGroup(owned.pid, "SIGTERM");
      const deadline =
        now().getTime() +
        (options.stopTimeoutMs ?? (options.captureCommand ? 4000 : DEFAULT_STOP_TIMEOUT_MS));
      while ((await inspection.groupExists(owned.pid)) && now().getTime() < deadline)
        await timing.wait(STOP_POLL_MS);
      if (await inspection.groupExists(owned.pid))
        await inspection.signalGroup(owned.pid, "SIGKILL");
      const killDeadline = now().getTime() + (options.killWaitMs ?? DEFAULT_KILL_WAIT_MS);
      while ((await inspection.groupExists(owned.pid)) && now().getTime() < killDeadline)
        await timing.wait(STOP_POLL_MS);
      if (await inspection.groupExists(owned.pid))
        throw new RigError(
          "STOP_TIMEOUT",
          "The process group did not stop.",
          "Inspect the Target process before retrying.",
          { key },
        );
    }
    await Promise.all(owned.drains);
    await owned.writes;
    await rm(leasePath(key), { force: true });
    if (options.captureCommand) await rm(capturePath(key), { force: true });
    return { outcome: before.state === "running" ? "stopped" : "unchanged" };
  }
  /** Ends restart scheduling and waits for in-flight operations so ownership can be handed over or ended. */
  async function quiesce(): Promise<void> {
    shuttingDown = true;
    for (const restart of restarts.values()) {
      restart.cancel?.();
      restart.cancel = undefined;
    }
    await Promise.all(
      [...operations.values()].map((pending) => pending.catch(() => {})),
    );
  }
  function scheduleRestart(key: string, owned: OwnedProcess): void {
    if (
      !owned.request?.keepAlive ||
      owned.stopped ||
      shuttingDown ||
      processes.get(key) !== owned
    )
      return;
    const restart = restarts.get(key) ?? { times: [] };
    const timestamp = now().getTime();
    restart.times = restart.times.filter(
      (time) => timestamp - time < (options.restartWindowMs ?? 60_000),
    );
    if (restart.times.length >= (options.restartLimit ?? 5)) return;
    restart.times.push(timestamp);
    const delay =
      (options.restartBackoffMs ?? 100) * 2 ** (restart.times.length - 1);
    restart.at = timestamp + delay;
    const cancel = timing.schedule(delay, () => {
      // A callback the platform queued before its cancellation is ignored; the process is only revived by a live schedule.
      if (restart.cancel !== cancel) return;
      restart.cancel = undefined;
      void serialized(key, async () => {
        if (!owned.stopped && !shuttingDown) {
          restarting.add(key);
          await ensureRunning(owned.request!);
        }
      })
        .finally(() => {
          restarting.delete(key);
        })
        .catch(() => {});
    });
    restart.cancel = cancel;
    restarts.set(key, restart);
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
    if (processes.has(request.key)) await stop(request.key);
    if (!request.command.length)
      throw new RigError(
        "COMMAND_EMPTY",
        "The managed component has no command.",
        "Configure a command.",
        { key: request.key },
      );
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
      request: options.captureCommand
        ? { ...request, keepAlive: false }
        : request,
      stopped: false,
      drains: [],
      writes: Promise.resolve(),
    };
    child.once("exit", (code) => {
      owned.exitCode = code ?? undefined;
      scheduleRestart(request.key, owned);
    });
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
              request: owned.request,
            }),
            { mode: 0o600 },
          );
          await rename(temporary, leasePath(request.key));
        } finally {
          await rm(temporary, { force: true });
        }
      }
      if (options.captureCommand)
        await waitForCaptureStart(capturePath(request.key));
    } catch (error) {
      await stop(request.key);
      throw error;
    }
    return { outcome: "started", pid: child.pid };
  }
  return {
    ensureRunning: (request) =>
      serialized(request.key, () => ensureRunning(request)),
    observe,
    stop: (key) => serialized(key, () => stop(key)),
    async shutdown() {
      await quiesce();
      await Promise.all([...processes.keys()].map(stop));
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
