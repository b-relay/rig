import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeStartupFailure } from "./startup-failure";
import { startControlPlane } from "./server";
import { readDaemonToken, ownerSchema } from "./files";
import type { RuntimeCommand } from "./protocol";
import { RigError } from "../domain/errors";
import { processStartTime, recordedProcess } from "./process-identity";
export interface DaemonHostOptions {
  root: string;
  port: number;
  handle(command: RuntimeCommand): Promise<unknown>;
  shutdown(): Promise<void>;
  start?(): Promise<void>;
  editor?(input: unknown): Promise<unknown>;
}
/** A lock directory without a holder record is stale once older than this. */
const GUARD_STALE_MS = 60_000;
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
/** Takes the startup lock, reclaiming one whose holder is gone. Refuses a lock
 * held by a live startup, or by an unknown one begun recently, naming the lock. */
async function acquireGuard(
  guard: string,
  owner: { pid: number; startedAt?: string },
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(guard, { mode: 0o700 });
      await writeFile(join(guard, "holder.json"), JSON.stringify(owner), {
        mode: 0o600,
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await readFile(join(guard, "holder.json"), "utf8")
      .then((text) =>
        ownerSchema
          .pick({ pid: true, startedAt: true })
          .parse(JSON.parse(text)),
      )
      .catch(() => undefined);
    if (holder) {
      const liveness = await recordedProcess(holder);
      if (liveness === "running" || liveness === "unverified")
        throw new RigError(
          "DAEMON_START_LOCK",
          "Another startup owns the daemon acquisition lock.",
          `The lock at ${guard} is held by pid ${holder.pid}, which is alive. Wait for that startup to finish; if no rigd is starting for this root, remove ${guard} and retry.`,
          { guard, pid: holder.pid },
        );
    } else {
      const age =
        Date.now() - (await stat(guard).catch(() => undefined))?.mtimeMs!;
      if (!(age >= GUARD_STALE_MS))
        throw new RigError(
          "DAEMON_START_LOCK",
          "Another startup owns the daemon acquisition lock.",
          `The lock at ${guard} was begun less than a minute ago by a startup that recorded no pid. Wait for it to finish; if no rigd is starting for this root, remove ${guard} and retry.`,
          { guard },
        );
    }
    await rm(guard, { recursive: true, force: true });
  }
  throw new RigError(
    "DAEMON_START_LOCK",
    "Another startup owns the daemon acquisition lock.",
    `The lock at ${guard} was taken again while this startup reclaimed it. Retry.`,
    { guard },
  );
}
async function acquireAndServe(options: DaemonHostOptions): Promise<void> {
  const directory = join(options.root, "daemon"),
    lease = join(directory, "owner.json"),
    guard = join(directory, "acquiring");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owner = {
    pid: process.pid,
    instanceId: randomUUID(),
    ...(await processStartTime(process.pid).then((startedAt) =>
      startedAt ? { startedAt } : {},
    )),
  };
  await acquireGuard(guard, owner);
  let acquired = false;
  try {
    let prior: unknown;
    try {
      prior = JSON.parse(await readFile(lease, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new RigError(
          "DAEMON_LEASE",
          "The daemon ownership record is invalid.",
          "Inspect daemon state before retrying.",
        );
    }
    if (prior !== undefined) {
      const parsed = ownerSchema.safeParse(prior);
      if (!parsed.success)
        throw new RigError(
          "DAEMON_LEASE",
          "The daemon ownership record is invalid.",
          "Inspect daemon state before retrying.",
        );
      // A pid alone is not identity: a lease whose pid was reused after a crash is stale.
      const liveness = await recordedProcess(parsed.data);
      if (liveness === "running")
        throw new RigError(
          "DAEMON_RUNNING",
          "Another rigd owns this state root.",
          "Run rigd status.",
          { pid: parsed.data.pid },
        );
      if (liveness === "unverified")
        throw new RigError(
          "DAEMON_RUNNING",
          "Another process may own this state root.",
          `The lease at ${lease} records pid ${parsed.data.pid}, which is alive, but was written by an older rigd without process identity. If no rigd is running for this root, remove ${lease} and retry.`,
          { pid: parsed.data.pid, lease },
        );
      await rm(lease);
    }
    await writeFile(lease, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    acquired = true;
  } finally {
    await rm(guard, { recursive: true });
  }
  let server: ReturnType<typeof startControlPlane> | undefined;
  const release = async () => {
    for (const path of [join(directory, "address.json"), lease]) {
      try {
        const saved = JSON.parse(await readFile(path, "utf8"));
        if (saved.instanceId === owner.instanceId) await rm(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  try {
    server = startControlPlane({
      port: options.port,
      token: await readDaemonToken(options.root),
      instanceId: owner.instanceId,
      handle: options.handle,
      ...(options.editor ? { editor: options.editor } : {}),
    });
    const nextAddress = join(directory, `address.${owner.instanceId}.next`);
    await writeFile(
      nextAddress,
      JSON.stringify({ ...owner, port: server.port }),
      { mode: 0o600 },
    );
    await rename(nextAddress, join(directory, "address.json"));
  } catch (error) {
    await server?.stop(true);
    if (acquired) await release();
    throw error;
  }
  let stopping = false;
  const stop = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await server!.stop(true);
      // Leave ownership evidence on failed shutdown; never publish a clean stop while children are uncertain.
      await options.shutdown();
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
  process.once("SIGTERM", () => stop());
  process.once("SIGINT", () => stop());
  // Listening is daemon readiness. Target reconciliation owns its own outcomes and may be slow.
  // Invoke synchronously so runtime serialization queues reconciliation before new commands.
  try {
    void options.start?.().catch(() => stop(1));
  } catch {
    stop(1);
  }
}
export { processExists } from "./process-identity";
