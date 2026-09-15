import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/** A Target log past this size is rotated before the next append; one previous generation is kept. */
export const TARGET_LOG_LIMIT_BYTES = 64 * 1024 * 1024;

/** Appends to a Target's `target.jsonl`, rotating a full file to `target.jsonl.1` first, and
 * bringing back a log directory that was removed underneath the running component. */
export async function appendTargetLog(
  logRoot: string,
  text: string,
  limitBytes = TARGET_LOG_LIMIT_BYTES,
): Promise<void> {
  const file = join(logRoot, "target.jsonl");
  try {
    if ((await stat(file)).size >= limitBytes) await rename(file, `${file}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await appendFile(file, text, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    await appendFile(file, text, { mode: 0o600 });
  }
}
