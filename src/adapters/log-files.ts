import { open, type FileHandle } from "node:fs/promises";
import { RigError } from "../domain/errors";

/** The most bytes the reader holds for one record, and reads from one file per follow poll. A longer run is reported as
 * one unreadable record without being held. Rig's own writers keep records far below it. */
export const LOG_WINDOW_BYTES = 4 * 1024 * 1024;
/** Bytes read per step when a recent read walks a file back from its end. */
const TAIL_CHUNK_BYTES = 1024 * 1024;

/** One open Target log file. `identity` survives a rename, so a rotated file is recognised under its new name. */
export interface OpenLog {
  readonly handle: FileHandle;
  readonly identity: string;
  readonly size: number;
}
/** A complete line of a file, newest first when walking back. `text` is absent for a run longer than the window, which
 * was skipped unread; `size` is the line's length in bytes without its newline, or with `atLeast`, the part of it walked
 * so far: a run longer than the window is yielded as soon as it is known to be one, before its start is found. */
export interface BackwardLine {
  readonly text?: string;
  readonly size: number;
  readonly atLeast?: true;
}

/** Opens a Target log for reading; undefined when it does not exist. Fails LOG_UNREADABLE naming the file when it
 * cannot be opened or is not a regular file. The caller closes the handle. */
export async function openLog(path: string): Promise<OpenLog | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw unreadableFile(path, code);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new RigError(
        "LOG_UNREADABLE",
        `The Target log ${path} is not a regular file.`,
        "Move it aside so Rig can write its log there, then read the logs again.",
        { path },
      );
    return {
      handle,
      identity: `${metadata.dev}:${metadata.ino}`,
      size: metadata.size,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function unreadableFile(path: string, code: string | undefined) {
  return new RigError(
    "LOG_UNREADABLE",
    `The Target log ${path} could not be read (${code ?? "unknown error"}).`,
    "Fix its permissions or move it aside, then read the logs again.",
    { path, code },
  );
}

/** Byte offset just past the last newline before `size`: where the file's complete lines end. 0 when it has none; an
 * unterminated final line is still being written and waits for a later read. Only the last window (and its newline) is
 * searched: an unterminated run longer than the window (output that never ends a line, such as a progress bar drawn with
 * carriage returns) is taken as ending at `size`, and read as one over-long record, so a read never scans a whole
 * file for a newline. `midRecord` says so: whatever is appended to that run before its newline belongs to it. */
export async function completeEnd(
  file: FileHandle,
  size: number,
): Promise<{ end: number; midRecord: boolean }> {
  const floor = Math.max(0, size - LOG_WINDOW_BYTES - 1);
  for (let end = size; end > floor;) {
    const start = Math.max(floor, end - TAIL_CHUNK_BYTES);
    const chunk = await readAt(file, start, end - start);
    const newline = chunk.lastIndexOf(10);
    if (newline !== -1) return { end: start + newline + 1, midRecord: false };
    end = start;
  }
  return floor > 0
    ? { end: size, midRecord: true }
    : { end: 0, midRecord: false };
}

/** The complete lines of `file` that end at or before `end` (0, an offset just past a newline, or the end of an
 * over-long unterminated run; see `completeEnd`), newest first, read back from `end` a chunk at a time so only the lines
 * the caller consumes are read. A line longer than the window is yielded without text, as soon as it has grown past the
 * window, and never held whole; a caller that stops there never reads the rest of it. */
export async function* linesBackward(
  file: FileHandle,
  end: number,
  /** `end` is the end of an unterminated over-long run (`completeEnd`'s `midRecord`), not just past a newline. */
  unterminated = false,
): AsyncGenerator<BackwardLine> {
  let position = end;
  /** Bytes from `position` up to the newest line not yet yielded, whose start is still unread; ends with its newline
   * (a newline of its own for an unterminated run, so the run is measured as a line). */
  let pending: Buffer = Buffer.from(unterminated ? "\n" : "");
  /** Bytes of an over-long line already walked past while looking for its start; 0 when none. */
  let skipped = 0;
  while (position > 0) {
    const start = Math.max(0, position - TAIL_CHUNK_BYTES);
    let bytes = await readAt(file, start, position - start);
    position = start;
    if (skipped) {
      const newline = bytes.lastIndexOf(10);
      if (newline === -1) {
        skipped += bytes.length;
        continue;
      }
      // Already yielded; its start is found, and the walk goes on with older lines.
      skipped = 0;
      bytes = bytes.subarray(0, newline + 1);
    } else if (pending.length) bytes = Buffer.concat([bytes, pending]);
    let stop = bytes.length;
    for (
      let newline = lastNewline(bytes, stop - 2);
      newline !== -1;
      newline = lastNewline(bytes, stop - 2)
    ) {
      yield line(bytes.subarray(newline + 1, stop - 1));
      stop = newline + 1;
    }
    pending = bytes.subarray(0, stop);
    if (pending.length > LOG_WINDOW_BYTES + 1 && position > 0) {
      skipped = pending.length;
      pending = Buffer.alloc(0);
      yield { size: skipped - 1, atLeast: true };
    }
  }
  if (!skipped && pending.length)
    yield line(pending.subarray(0, pending.length - 1));
}

/** The next newline at or after `from`, searched at most one window far (and never past `size`): `past` is the offset
 * just after it, or undefined when there is none in that stretch; `scanned` is where the search stopped. So one read of a
 * run without a newline costs a window, however long the run has grown. */
export async function nextNewline(
  file: FileHandle,
  from: number,
  size: number,
): Promise<{ past?: number; scanned: number }> {
  const limit = Math.min(size, from + LOG_WINDOW_BYTES);
  const bytes = await readAt(file, from, limit - from);
  const newline = bytes.indexOf(10);
  return newline === -1
    ? { scanned: from + bytes.length }
    : { past: from + newline + 1, scanned: from + newline + 1 };
}

export async function readAt(
  file: FileHandle,
  start: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

function line(bytes: Buffer): BackwardLine {
  if (bytes.length > LOG_WINDOW_BYTES) return { size: bytes.length };
  return {
    text: bytes.toString("utf8").replace(/\r$/, ""),
    size: bytes.length,
  };
}
/** The last newline at or before `from`; -1 when there is none or `from` is before the buffer. */
function lastNewline(bytes: Buffer, from: number): number {
  return from < 0 ? -1 : bytes.lastIndexOf(10, from);
}
