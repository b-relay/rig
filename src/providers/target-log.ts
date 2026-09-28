import { appendFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_LOG_RETENTION,
  type LogRetention,
} from "../domain/log-retention";
/** A rotation lock older than this was left by a writer that died mid-rotation and is reclaimed. */
const STALE_ROTATION_MS = 30_000;

/** Appends to a Target's `target.jsonl`, rotating a full file first (see `rotateLogFile`), and bringing back a log
 * directory that was removed underneath the running component. */
export async function appendTargetLog(
  logRoot: string,
  text: string,
  retention: LogRetention = DEFAULT_LOG_RETENTION,
): Promise<void> {
  const file = join(logRoot, "target.jsonl");
  await rotateLogFile(file, retention);
  try {
    await appendFile(file, text, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    await appendFile(file, text, { mode: 0o600 });
  }
}

/** Rotates `file` once it holds `retention.maxBytes`: each kept generation moves one number up (`file` becomes `file.1`),
 * the one past `retention.generations` is dropped, and so are older ones a larger setting left behind. The next write
 * creates a fresh `file`. Every writer of a Target log may call this at once; a `<file>.rotating` lock makes one of them
 * rotate while the others skip it and keep writing. A missing file or directory is nothing to rotate. */
export async function rotateLogFile(
  file: string,
  retention: LogRetention,
): Promise<void> {
  if (!(await isFull(file, retention.maxBytes))) return;
  const lock = `${file}.rotating`;
  if (!(await acquireLock(lock))) return;
  try {
    // Another writer may have rotated between the size check and the lock.
    if (!(await isFull(file, retention.maxBytes))) return;
    await dropGenerationsFrom(file, retention.generations + 1);
    for (let generation = retention.generations; generation >= 1; generation--)
      await renamePresent(
        generation === 1 ? file : `${file}.${generation - 1}`,
        `${file}.${generation}`,
      );
    if (retention.generations === 0) await rm(file, { force: true });
  } finally {
    await rm(lock, { force: true });
  }
}

async function isFull(file: string, maxBytes: number): Promise<boolean> {
  try {
    return (await stat(file)).size >= maxBytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Takes the rotation lock, reclaiming one a crashed writer left; false while another writer holds it. */
async function acquireLock(lock: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      if (code !== "EEXIST") throw error;
    }
    const held = await stat(lock).catch(() => undefined);
    if (held && Date.now() - held.mtimeMs < STALE_ROTATION_MS) return false;
    await rm(lock, { force: true });
  }
  return false;
}
/** Removes `<file>.<from>`, `<file>.<from + 1>`, … up to the first number that is not there. */
async function dropGenerationsFrom(file: string, from: number): Promise<void> {
  for (let generation = from; ; generation++) {
    try {
      await rm(`${file}.${generation}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
async function renamePresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
