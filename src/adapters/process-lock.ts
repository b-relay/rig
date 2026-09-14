import { open, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { z } from "zod";
import { processStartTime, recordedProcess } from "../daemon/process-identity";

/** A lock whose holder cannot be read is stale once older than this. */
export const LOCK_STALE_MS = 60_000;
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
  /** "alive": a recorded process holds it. "fresh": no readable holder, taken less than a minute ago. "contended": taken again while being reclaimed. */
  reason: "alive" | "fresh" | "contended";
  pid?: number;
}
export type LockAcquisition = { lock: FileHandle } | { held: LockHeld };
/** Takes an exclusive lock file recording this process, reclaiming one whose
 * holder has exited, was replaced, or left no readable holder more than a
 * minute ago. A lock held by a live process, or an unreadable one that is
 * still fresh, is reported rather than taken. The caller closes the handle and
 * removes the file when its work is done. */
export async function acquireProcessLock(
  lockPath: string,
): Promise<LockAcquisition> {
  const holder = {
    pid: process.pid,
    ...(await processStartTime(process.pid).then((startedAt) =>
      startedAt ? { startedAt } : {},
    )),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify(holder));
      return { lock };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const recorded = await readFile(lockPath, "utf8")
      .then((text) => holderSchema.parse(JSON.parse(text)))
      .catch(() => undefined);
    if (recorded) {
      const liveness = await recordedProcess(recorded);
      if (liveness === "running" || liveness === "unverified")
        return { held: { lockPath, reason: "alive", pid: recorded.pid } };
    } else {
      const age =
        Date.now() -
        ((await stat(lockPath).catch(() => undefined))?.mtimeMs ?? Date.now());
      if (age < LOCK_STALE_MS) return { held: { lockPath, reason: "fresh" } };
    }
    await rm(lockPath, { force: true });
  }
  return { held: { lockPath, reason: "contended" } };
}
