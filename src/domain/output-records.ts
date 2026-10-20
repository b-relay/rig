/** The most UTF-8 bytes of output one Target log record holds. A longer line is recorded as consecutive records of the
 * same component and stream, cut only between characters: after JSON escaping (at most 6 bytes for a byte of output) every
 * record stays far inside the 4 MiB the log reader takes in one read, and holds well-formed text. */
export const MAX_RECORD_LINE_BYTES = 64 * 1024;

/** One output stream of a process, turned into the lines of its Target log records. */
export interface OutputLines {
  /** Takes the next chunk, bytes or text the stream's own decoder made, and returns the record lines it completes: each
   * line ended by a newline (a `\r` before it dropped), and pieces of a run that has passed MAX_RECORD_LINE_BYTES without
   * one. A character split across chunks is held until its last byte arrives. */
  push(chunk: Uint8Array | string): string[];
  /** The record lines of what is left once the stream ends: an unterminated final line, if any. */
  end(): string[];
}

/** Pure: a fresh `OutputLines` for one stream. Nothing is dropped: the record lines of a stream join back to its text, its
 * newlines (and a `\r` before one) aside, with bytes that are not UTF-8 as U+FFFD. What is held between chunks is at
 * most one record's worth plus the latest chunk. */
export function outputLines(): OutputLines {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let pending = "";
  return {
    push(chunk) {
      const text =
        pending +
        (typeof chunk === "string"
          ? chunk
          : decoder.decode(chunk, { stream: true }));
      const lines: string[] = [];
      let start = 0;
      for (
        let newline = text.indexOf("\n");
        newline !== -1;
        newline = text.indexOf("\n", start)
      ) {
        const end = text[newline - 1] === "\r" ? newline - 1 : newline;
        lines.push(...recordPieces(text.slice(start, end)));
        start = newline + 1;
      }
      // A run without a newline is recorded as soon as it fills a record; the last piece waits for more of it.
      const rest = recordPieces(text.slice(start));
      pending = rest.pop() ?? "";
      lines.push(...rest);
      return lines;
    },
    end() {
      const rest = pending + decoder.decode();
      pending = "";
      return rest ? recordPieces(rest) : [];
    },
  };
}

/** Pure: `line` as the lines of its records: itself when it holds at most MAX_RECORD_LINE_BYTES of UTF-8, otherwise
 * pieces of at most that many bytes, in order, each cut between characters (never inside a surrogate pair), that join
 * back to `line`. */
export function recordPieces(line: string): string[] {
  // A UTF-16 unit is at most 3 bytes of UTF-8.
  if (line.length * 3 <= MAX_RECORD_LINE_BYTES) return [line];
  const pieces: string[] = [];
  let start = 0,
    bytes = 0;
  for (let at = 0; at < line.length;) {
    const code = line.codePointAt(at)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > MAX_RECORD_LINE_BYTES) {
      pieces.push(line.slice(start, at));
      start = at;
      bytes = 0;
    }
    bytes += size;
    at += code > 0xffff ? 2 : 1;
  }
  pieces.push(line.slice(start));
  return pieces;
}
