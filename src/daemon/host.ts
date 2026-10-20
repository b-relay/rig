import { randomUUID } from "node:crypto";
import { rm, readFile } from "node:fs/promises";
import {
  privateDirectory,
  replacePrivateFile,
} from "../providers/private-files";
import { join } from "node:path";
import { writeStartupFailure } from "./startup-failure";
import { startControlPlane } from "./server";
import { readDaemonToken, ownerSchema } from "./files";
import type { RuntimeCommand } from "./protocol";
import { RigError } from "../domain/errors";
import type { z } from "zod";
import { processStartTime, recordedProcess } from "./process-identity";
import { acquireProcessLock, type ProcessLock } from "../adapters/process-lock";

/** How long a stop waits for a command that is still answering after the runtime has shut down. */
const DRAIN_GRACE_MS = 30_000;
/** Resolves when `settled` does or after `ms`, whichever is first. The timer is cleared as soon as
 * `settled` resolves, so it holds the process open only while a reply is genuinely outstanding. */
function withinGrace(settled: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void settled.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
export interface DaemonHostOptions {
  root: string;
  port: number;
  handle(command: RuntimeCommand): Promise<unknown>;
  /** Readies rigd to stop while it still serves: what must be confirmed before anything stops (the dashboard's domain
   * withheld by Rig's Caddy) is done, or this rejects saying why, and rigd keeps serving. Asked before every stop, and by
   * `rigd install` and `rigd uninstall` (the `prepare-stop` command) before they stop rigd. */
  prepareStop?(): Promise<void>;
  shutdown(): Promise<void>;
  start?(): Promise<void>;
  editor?(input: unknown): Promise<unknown>;
  env?(input: unknown): Promise<unknown>;
  /** Where rigd serves the dashboard, reported by /health; absent when it runs none, or (a function answering undefined)
   * once it has stopped it. */
  dashboard?: string | (() => string | undefined);
  /** Why the dashboard it runs is not served now (see Dashboard.problem), reported by /health. */
  dashboardProblem?: () => string | undefined;
}
/** Exclusive startup guard serializes stale-lease reclamation. Ambiguous ownership fails closed. */
export async function runDaemonHost(options: DaemonHostOptions): Promise<void> {
  try {
    await acquireAndServe(options);
  } catch (error) {
    // The installer cannot see this process's stderr; leave it the cause.
    await writeStartupFailure(options.root, error);
    throw error;
  }
}
/** Takes the startup lock, which one startup holds at a time and a dead one no longer holds. Refuses a lock held by a
 * live startup, naming the lock and its pid. */
async function acquireGuard(guard: string): Promise<ProcessLock> {
  const acquired = await acquireProcessLock(guard);
  if ("lock" in acquired) return acquired.lock;
  const { pid } = acquired.held;
  throw new RigError(
    "DAEMON_START_LOCK",
    "Another startup owns the daemon acquisition lock.",
    `The lock at ${guard} is held by ${pid ? `pid ${pid}` : "another process"}, which is still running. Wait for that startup to finish, then retry.`,
    { guard, ...(pid ? { pid } : {}) },
  );
}
/** The prior lease, or undefined when there is none or it is unreadable and no
 * recorded address names a live process. A torn or corrupt lease cannot identify
 * a daemon; the address record is the only other evidence, so it decides. */
async function readLease(
  lease: string,
  address: string,
): Promise<z.infer<typeof ownerSchema> | undefined> {
  const parse = async (path: string) =>
    ownerSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  const prior = await parse(lease).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : { success: false as const },
  );
  if (!prior) return undefined;
  if (prior.success) return prior.data;
  const recorded = await parse(address).catch(() => undefined);
  if (recorded?.success) {
    const liveness = await recordedProcess(recorded.data);
    if (liveness === "running" || liveness === "unverified")
      throw new RigError(
        "DAEMON_LEASE",
        "The daemon ownership record is invalid, and its address record names a live process.",
        `The lease at ${lease} cannot be read, but ${address} records pid ${recorded.data.pid}, which is alive. If no rigd is running for this root, remove both and retry.`,
        { lease, address, pid: recorded.data.pid },
      );
  }
  return undefined;
}
/** The instanceId a record names, or undefined when it is absent or unreadable. */
async function recordedInstance(path: string): Promise<string | undefined> {
  try {
    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof saved === "object" &&
      saved !== null &&
      "instanceId" in saved &&
      typeof saved.instanceId === "string"
      ? saved.instanceId
      : undefined;
  } catch {
    return undefined;
  }
}
async function acquireAndServe(options: DaemonHostOptions): Promise<void> {
  const directory = join(options.root, "daemon"),
    lease = join(directory, "owner.json"),
    guard = join(directory, "acquiring.lock");
  await privateDirectory(options.root, directory);
  const owner = {
    pid: process.pid,
    instanceId: randomUUID(),
    ...(await processStartTime(process.pid).then((startedAt) =>
      startedAt ? { startedAt } : {},
    )),
  };
  const guarded = await acquireGuard(guard);
  let acquired = false;
  try {
    const prior = await readLease(lease, join(directory, "address.json"));
    if (prior) {
      // A pid alone is not identity: a lease whose pid was reused after a crash is stale.
      const liveness = await recordedProcess(prior);
      if (liveness === "running")
        throw new RigError(
          "DAEMON_RUNNING",
          "Another rigd owns this state root.",
          "Run rigd status.",
          { pid: prior.pid },
        );
      if (liveness === "unverified")
        throw new RigError(
          "DAEMON_RUNNING",
          "Another process may own this state root.",
          `The lease at ${lease} records pid ${prior.pid}, which is alive, but was written by an older rigd without process identity. If no rigd is running for this root, remove ${lease} and retry.`,
          { pid: prior.pid, lease },
        );
    }
    // Written whole, so a crash here leaves the previous record or a valid one, never a torn one.
    await replacePrivateFile(options.root, lease, JSON.stringify(owner));
    acquired = true;
  } finally {
    // Only this startup's own lock is released, and a lock file that cannot be removed does not fail a startup that
    // already holds the lease.
    await guarded.release().catch(() => {});
  }
  let server: ReturnType<typeof startControlPlane> | undefined;
  // A record that no longer names this instance, or cannot be read at all, is not ours to remove.
  const release = async () => {
    for (const path of [join(directory, "address.json"), lease])
      if ((await recordedInstance(path)) === owner.instanceId) await rm(path);
  };
  try {
    server = startControlPlane({
      port: options.port,
      token: await readDaemonToken(options.root),
      instanceId: owner.instanceId,
      handle: async (command) => {
        if (command.action !== "prepare-stop") return options.handle(command);
        await options.prepareStop?.();
        return { ready: true };
      },
      ...(options.editor ? { editor: options.editor } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.dashboard ? { dashboard: options.dashboard } : {}),
      ...(options.dashboardProblem
        ? { dashboardProblem: options.dashboardProblem }
        : {}),
    });
    await replacePrivateFile(
      options.root,
      join(directory, "address.json"),
      JSON.stringify({ ...owner, port: server.port }),
    );
  } catch (error) {
    await server?.stop(true);
    // Release failing must not replace the error that stopped startup.
    if (acquired) await release().catch(() => {});
    throw error;
  }
  let stopping = false;
  const stop = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      // While rigd still serves, so a stop it cannot make safely leaves it serving and reachable, saying why; a later
      // signal tries again.
      try {
        await options.prepareStop?.();
      } catch {
        stopping = false;
        return;
      }
      // Stop accepting connections but let in-flight commands answer: the runtime
      // drains them during shutdown, so their callers learn the recorded outcome.
      const closed = server!.stop(false);
      // Leave ownership evidence on failed shutdown; never publish a clean stop while children are uncertain.
      await options.shutdown();
      // The graceful stop settles once every reply in flight has been sent and idle connections
      // are closed; forcing the close before then cuts a caller off. A handler that never
      // returns must not keep the daemon alive, so the wait is bounded.
      await withinGrace(closed, DRAIN_GRACE_MS);
      await server!.stop(true);
      await closed;
      await release();
    })().then(
      () => {
        process.exitCode = exitCode;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGTERM", () => stop());
  process.on("SIGINT", () => stop());
  // Listening is daemon readiness. Target reconciliation owns its own outcomes and may be slow.
  // Invoke synchronously so runtime serialization queues reconciliation before new commands.
  try {
    void options.start?.().catch(() => stop(1));
  } catch {
    stop(1);
  }
}
export { processExists } from "./process-identity";
