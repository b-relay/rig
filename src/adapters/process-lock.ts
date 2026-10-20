import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  writeSync,
  type Stats,
} from "node:fs";
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
/** lockf(1)'s exit status when another holds the lock. */
const EX_TEMPFAIL = 75;
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
      // A rig from before flock took its lock by creating the file alone; while its recorded process is alive (one that
      // recorded no start time cannot be told from a reused pid), it holds it.
      const liveness =
        prior && prior.pid !== process.pid
          ? await recordedProcess(prior)
          : "exited";
      if (prior && (liveness === "running" || liveness === "unverified")) {
        await handle.close();
        return { held: { lockPath, pid: prior.pid } };
      }
      await recordHolder(handle.fd);
      return { lock: heldLock(lockPath, handle, mine, options.keep === true) };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }
  return { held: { lockPath } };
}
/** Holds the lock at `lockPath` through `fd`, a descriptor open on that lock file that the process which started this one
 * passed down, so the lock stays held while this process runs even if that one has died. The descriptor must be open on
 * the file now at `lockPath`; then lockf(1) takes the lock on it, which succeeds when its open file (shared with the parent)
 * already holds it or no one does, and fails when another holds it. Undefined when `fd` is not open on that file; the
 * caller then takes the lock itself. Released, the descriptor is closed and the file left in place. */
export async function inheritProcessLock(
  lockPath: string,
  fd: number,
): Promise<LockAcquisition | undefined> {
  let inherited: Stats;
  try {
    inherited = fstatSync(fd);
  } catch {
    return undefined;
  }
  if (!sameFile(inherited, await lstat(lockPath).catch(() => undefined)))
    return undefined;
  const code = await Bun.spawn(["/usr/bin/lockf", "-s", "-t", "0", "3"], {
    stdio: ["ignore", "ignore", "ignore", fd],
  }).exited;
  if (code === EX_TEMPFAIL)
    return { held: { lockPath, ...(await recordedPid(lockPath)) } };
  if (code !== 0)
    throw new Error(`lockf could not lock ${lockPath} (exit ${code}).`);
  // The process that passed the lock down holds it after this one; released, the file names it again.
  const passer = await readFile(lockPath, "utf8").catch(() => "");
  await recordHolder(fd);
  let released = false;
  return {
    lock: {
      async release() {
        if (released) return;
        released = true;
        try {
          ftruncateSync(fd, 0);
          writeSync(fd, passer, 0);
        } finally {
          closeSync(fd);
        }
      },
    },
  };
}
/** Records this process, pid and start time, as the holder in the lock file open at `fd`, for whoever is refused. */
async function recordHolder(fd: number): Promise<void> {
  const startedAt = await processStartTime(process.pid);
  ftruncateSync(fd, 0);
  writeSync(
    fd,
    JSON.stringify({ pid: process.pid, ...(startedAt ? { startedAt } : {}) }),
    0,
  );
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
