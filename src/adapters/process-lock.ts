import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { z } from "zod";
import { processStartTime, recordedProcess } from "../daemon/process-identity";

/** macOS open(2) flags Node does not name: O_EXLOCK takes flock(2)'s exclusive lock as the file opens (with O_NONBLOCK,
 * failing EAGAIN at once when another descriptor holds it); O_CLOEXEC keeps the lock out of child processes. The kernel
 * drops the lock when the descriptor closes or its process dies, so a crashed holder leaves nothing to reclaim. */
const O_EXLOCK = 0x20;
const O_CLOEXEC = 0x1000000;
const LOCK_FLAGS =
  constants.O_RDWR |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK |
  O_EXLOCK |
  O_CLOEXEC;
/** How often an acquisition retries a lock file another holder removed between this open and its lock. */
const REOPENS = 10;
const holderSchema = z.object({
  pid: z.number().int().positive().describe("Process holding the lock."),
  startedAt: z
    .string()
    .min(1)
    .optional()
    .describe("Start time of that process, which tells a reused pid apart."),
});
/** Why a lock could not be taken: the caller turns this into its own error. */
export interface LockHeld {
  lockPath: string;
  /** The holder's pid, when it has recorded one. */
  pid?: number;
}
/** A held lock. `release` drops it, removing the lock file only while it is still this lock's own. */
export interface ProcessLock {
  release(): Promise<void>;
}
export type LockAcquisition = { lock: ProcessLock } | { held: LockHeld };
/** Takes the exclusive lock at `lockPath`, or reports who holds it. The lock is flock(2)'s on the open file, so one holder
 * at a time is the kernel's guarantee, and a holder that dies releases it. The file records the holder's pid and start time
 * for whoever is refused. `keep` leaves the file in place when released (emptied), for a lock that other programs take
 * with lockf(1), which does not notice a lock file removed under it. */
export async function acquireProcessLock(
  lockPath: string,
  options: { keep?: boolean } = {},
): Promise<LockAcquisition> {
  for (let attempt = 0; attempt < REOPENS; attempt++) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, LOCK_FLAGS, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      return { held: { lockPath, ...(await recordedPid(lockPath)) } };
    }
    try {
      const mine = await handle.stat();
      // A holder that released by removing the file left this descriptor locking a file no longer at the path.
      if (!sameFile(mine, await lstat(lockPath).catch(() => undefined))) {
        await handle.close();
        continue;
      }
      const prior = await recordedHolder(lockPath);
      // A rig from before flock took its lock by creating the file alone; while its recorded process runs, it holds it.
      if (
        prior &&
        prior.pid !== process.pid &&
        (await recordedProcess(prior)) === "running"
      ) {
        await handle.close();
        return { held: { lockPath, pid: prior.pid } };
      }
      const startedAt = await processStartTime(process.pid);
      await handle.truncate(0);
      await handle.write(
        JSON.stringify({
          pid: process.pid,
          ...(startedAt ? { startedAt } : {}),
        }),
        0,
      );
      return { lock: heldLock(lockPath, handle, mine, options.keep === true) };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }
  return { held: { lockPath } };
}
function heldLock(
  lockPath: string,
  handle: FileHandle,
  mine: Stats,
  keep: boolean,
): ProcessLock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        // Still holding the lock, so no one else can have taken this file; a file someone put in its place is theirs.
        if (keep) await handle.truncate(0);
        else if (sameFile(mine, await lstat(lockPath).catch(() => undefined)))
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
      } finally {
        await handle.close();
      }
    },
  };
}
const sameFile = (a: Stats, b: Stats | undefined) =>
  b !== undefined && a.dev === b.dev && a.ino === b.ino;
async function recordedHolder(
  lockPath: string,
): Promise<z.infer<typeof holderSchema> | undefined> {
  return await readFile(lockPath, "utf8")
    .then((text) => holderSchema.parse(JSON.parse(text)))
    .catch(() => undefined);
}
async function recordedPid(lockPath: string): Promise<{ pid?: number }> {
  const holder = await recordedHolder(lockPath);
  return holder ? { pid: holder.pid } : {};
}
