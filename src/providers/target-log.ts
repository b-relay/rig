import {
  appendFile,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
 * creates a fresh `file`. Every writer of a Target log may call this at once; a rotation lock makes one of them rotate
 * while the others skip it and keep writing (see `acquireRotationLock`). A missing file or directory is nothing to
 * rotate. */
export async function rotateLogFile(
  file: string,
  retention: LogRetention,
): Promise<void> {
  const full = await fullFile(file, retention.maxBytes);
  if (!full) return;
  const lock = await acquireRotationLock(file, full);
  if (!lock) return;
  // A holder that stalled past STALE_ROTATION_MS (a Mac asleep mid-rotation) has had its lock removed by the writer that
  // passed it over, which may have rotated since: it checks before every step and stops, leaving the locks to that one.
  const held = () => exists(lock);
  try {
    // Lost at once: the writer that passed it over owns the rotation and its locks.
    if (!(await held())) return;
    // Another writer may have rotated this file between the size check and the lock.
    if ((await fullFile(file, retention.maxBytes)) === full) {
      await dropGenerationsFrom(file, retention.generations + 1);
      for (
        let generation = retention.generations;
        generation >= 1;
        generation--
      ) {
        if (!(await held())) return;
        await renamePresent(
          generation === 1 ? file : `${file}.${generation - 1}`,
          `${file}.${generation}`,
        );
      }
      if (retention.generations === 0) {
        if (!(await held())) return;
        await rm(file, { force: true });
      }
    }
  } catch (error) {
    await rm(lock, { force: true });
    throw error;
  }
  // This file is no longer the current one, so no writer will rotate it again: every lock of it can go, and so can a
  // stale lock of any other earlier file, which a writer that crashed after moving that file left behind.
  await removeRotationLocks(
    file,
    (identity, age) => identity === full || age >= STALE_ROTATION_MS,
  );
}

/** The identity (`<dev>-<ino>`) of `file` when it holds at least `maxBytes`; undefined when it is smaller or missing. */
async function fullFile(
  file: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const metadata = await stat(file);
    return metadata.size >= maxBytes
      ? `${metadata.dev}-${metadata.ino}`
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** The lock for rotating one file: `<file>.rotating-<identity>-<n>`, created exclusively. One a crashed or stalled writer
 * left (older than STALE_ROTATION_MS) is passed over by creating the next number, which only one writer can create; that
 * writer then removes the older ones, so a stalled holder that wakes finds its lock gone and stops (see
 * `rotateLogFile`). Every lock of a file is removed once that file has been rotated. Undefined while another writer holds
 * the newest lock. */
export async function acquireRotationLock(
  file: string,
  identity: string,
): Promise<string | undefined> {
  const prefix = `${basename(file)}.rotating-${identity}-`;
  const numbers = (await listNames(dirname(file)))
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((suffix) => /^\d+$/.test(suffix))
    .map(Number);
  const newest = numbers.length ? Math.max(...numbers) : -1;
  if (newest >= 0) {
    const held = await stat(join(dirname(file), `${prefix}${newest}`)).catch(
      () => undefined,
    );
    // Gone: its holder has just rotated the file.
    if (!held || Date.now() - held.mtimeMs < STALE_ROTATION_MS)
      return undefined;
  }
  const lock = join(dirname(file), `${prefix}${newest + 1}`);
  try {
    await (await open(lock, "wx", 0o600)).close();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return undefined;
    throw error;
  }
  for (const number of numbers)
    await rm(join(dirname(file), `${prefix}${number}`), { force: true });
  return lock;
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Removes the rotation locks of `file` that `select` picks by the identity of the file they lock and their age. */
async function removeRotationLocks(
  file: string,
  select: (identity: string, ageMs: number) => boolean,
): Promise<void> {
  const marker = `${basename(file)}.rotating-`;
  for (const name of await listNames(dirname(file))) {
    if (!name.startsWith(marker)) continue;
    const identity = /^(.+)-\d+$/.exec(name.slice(marker.length))?.[1];
    if (identity === undefined) continue;
    const path = join(dirname(file), name);
    const held = await stat(path).catch(() => undefined);
    if (held && select(identity, Date.now() - held.mtimeMs))
      await rm(path, { force: true });
  }
}
async function listNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
/** Removes every `<file>.<n>` with n at least `from`, whatever gaps an interrupted rotation left between them. */
async function dropGenerationsFrom(file: string, from: number): Promise<void> {
  const prefix = `${basename(file)}.`;
  for (const name of await listNames(dirname(file))) {
    if (!name.startsWith(prefix)) continue;
    const generation = name.slice(prefix.length);
    if (/^[1-9]\d*$/.test(generation) && Number(generation) >= from)
      await rm(join(dirname(file), name), { force: true });
  }
}
async function renamePresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
