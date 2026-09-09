import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { startControlPlane } from "./server";
import { readDaemonToken, ownerSchema } from "./files";
import type { RuntimeCommand } from "./protocol";
import { RigError } from "../domain/errors";
export interface DaemonHostOptions {
  root: string;
  port: number;
  handle(command: RuntimeCommand): Promise<unknown>;
  shutdown(): Promise<void>;
  start?(): Promise<void>;
  editor?(input: unknown): Promise<unknown>;
}
/** Exclusive startup guard serializes stale-lease reclamation. Ambiguous ownership fails closed. */
export async function runDaemonHost(options: DaemonHostOptions): Promise<void> {
  const directory = join(options.root, "daemon"),
    lease = join(directory, "owner.json"),
    guard = join(directory, "acquiring");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await mkdir(guard, { mode: 0o700 });
  } catch {
    throw new RigError(
      "DAEMON_START_LOCK",
      "Another startup owns the daemon acquisition lock.",
      "Wait for startup; if interrupted, inspect daemon ownership before removing the acquisition lock.",
    );
  }
  const owner = { pid: process.pid, instanceId: randomUUID() };
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
      if (processExists(parsed.data.pid))
        throw new RigError(
          "DAEMON_RUNNING",
          "Another rigd owns this state root.",
          "Run rigd status.",
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
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
