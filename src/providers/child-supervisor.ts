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
import { RigError } from "../domain/errors";
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
const leaseSchema = z.object({
  key: z.string().describe("Stable component ownership key."),
  pid: z.number().int().min(2).describe("Owned process group leader."),
  identity: z
    .string()
    .length(64)
    .describe("Digest of immutable process birth time and PID."),
});
const maximumSerializedLogRecordBytes = 1_048_576;
interface OwnedProcess {
  pid: number;
  identity?: string;
  child?: ChildProcess;
  request?: ManagedProcess;
  exitCode?: number;
  stopped: boolean;
  drains: Promise<void>[];
  writes: Promise<void>;
  writeError?: unknown;
}
export interface ChildSupervisorOptions {
  readonly stateRoot: string;
  readonly stopTimeoutMs?: number;
  readonly now?: () => Date;
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
    { times: number[]; timer?: ReturnType<typeof setTimeout> }
  >();
  const now = options.now ?? (() => new Date());
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
    if ((await inspect(parsed.data.pid)) !== parsed.data.identity)
      return undefined;
    const owned: OwnedProcess = {
      pid: parsed.data.pid,
      identity: parsed.data.identity,
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
        ...(restarting.has(key) || (!owned.stopped && restarts.get(key)?.timer)
          ? { restartPending: true }
          : {}),
      };
    if (owned.child) {
      try {
        process.kill(owned.pid, 0);
        return {
          state: "running",
          pid: owned.pid,
          ...(owned.writeError
            ? { reason: "Target output could not be recorded." }
            : {}),
        };
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
          ? { state: "stopped" }
          : {
              state: "unknown",
              reason: "Process presence could not be checked.",
            };
      }
    }
    try {
      return (await inspect(owned.pid)) === owned.identity
        ? { state: "running", pid: owned.pid }
        : { state: "stopped" };
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
    if (restart?.timer) {
      clearTimeout(restart.timer);
      restart.timer = undefined;
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
    const verified =
      Boolean(liveChild) ||
      (owned.child
        ? currentIdentity === undefined || currentIdentity === owned.identity
        : currentIdentity === owned.identity);
    if (verified) {
      await inspection.signalGroup(owned.pid, "SIGTERM");
      const deadline =
        Date.now() +
        (options.stopTimeoutMs ?? (options.captureCommand ? 4000 : 1500));
      while ((await inspection.groupExists(owned.pid)) && Date.now() < deadline)
        await Bun.sleep(20);
      if (await inspection.groupExists(owned.pid))
        await inspection.signalGroup(owned.pid, "SIGKILL");
      const killDeadline = Date.now() + 1500;
      while ((await inspection.groupExists(owned.pid)) && Date.now() < killDeadline)
        await Bun.sleep(20);
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
    const timer = setTimeout(
      () => {
        void serialized(key, async () => {
          if (!owned.stopped && !shuttingDown) {
            restarting.add(key);
            await ensureRunning(owned.request!);
          }
        })
          .finally(() => {
            restarting.delete(key);
            if (restart.timer === timer) restart.timer = undefined;
          })
          .catch(() => {});
      },
      (options.restartBackoffMs ?? 100) * 2 ** (restart.times.length - 1),
    );
    restart.timer = timer;
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
      shuttingDown = true;
      for (const restart of restarts.values())
        if (restart.timer) clearTimeout(restart.timer);
      await Promise.all(
        [...operations.values()].map((pending) => pending.catch(() => {})),
      );
      await Promise.all([...processes.keys()].map(stop));
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
        const emit = (line: string) => {
          const timestamp = now().toISOString();
          for (const chunk of splitLogLine(
            line,
            timestamp,
            request.componentName,
            stream,
          )) {
            const entry: TargetLogEntry = {
              timestamp,
              component: request.componentName,
              stream,
              line: chunk,
            };
            owned.writes = owned.writes
              .then(() =>
                appendFile(
                  join(request.logRoot, "target.jsonl"),
                  JSON.stringify(entry) + "\n",
                  { mode: 0o600 },
                ),
              )
              .catch((error) => {
                owned.writeError = error;
              });
          }
        };
        pipe.on("data", (chunk: Buffer) => {
          pending += decoder.write(chunk);
          let newline: number;
          while ((newline = pending.indexOf("\n")) !== -1) {
            emit(pending.slice(0, newline).replace(/\r$/, ""));
            pending = pending.slice(newline + 1);
          }
          if (pending.length > 1_048_576) {
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

function splitLogLine(
  line: string,
  timestamp: string,
  component: string,
  stream: TargetLogEntry["stream"],
): string[] {
  const emptyRecordBytes = Buffer.byteLength(
    JSON.stringify({ timestamp, component, stream, line: "" }) + "\n",
  );
  const contentBudget = maximumSerializedLogRecordBytes - emptyRecordBytes;
  const chunks: string[] = [];
  let start = 0;
  let cursor = 0;
  let escapedBytes = 0;
  while (cursor < line.length) {
    const codePoint = line.codePointAt(cursor)!;
    const next = cursor + (codePoint > 0xffff ? 2 : 1);
    const encoded = JSON.stringify(String.fromCodePoint(codePoint))!.slice(1, -1);
    const encodedBytes = Buffer.byteLength(encoded);
    if (escapedBytes + encodedBytes > contentBudget && cursor > start) {
      chunks.push(line.slice(start, cursor));
      start = cursor;
      escapedBytes = 0;
    }
    escapedBytes += encodedBytes;
    cursor = next;
  }
  chunks.push(line.slice(start));
  return chunks;
}
