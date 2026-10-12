/** A terminal's size now, in character cells. */
export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/** A block of terminal lines redrawn in place below whatever was written before it: each draw moves up over the lines
 * the last one wrote, clears to the end of the screen and writes the new ones, each cut to `columns` so it takes one
 * row. An unchanged block is not written again. */
export function liveRegion(write: (text: string) => void, columns: number) {
  let drawn: string[] = [];
  return {
    draw(lines: readonly string[]) {
      const next = lines.map((line) => fitted(line, columns));
      if (next.join("\n") === drawn.join("\n")) return;
      // Up to the region's first row, then clear to the end of the screen before writing it again.
      const erase = drawn.length ? `\x1b[${drawn.length}A\r\x1b[J` : "";
      write(`${erase}${next.map((line) => `${line}\n`).join("")}`);
      drawn = next;
    },
    /** Leaves the drawn lines as they are, after other text was written below them: the next draw starts afresh. */
    release() {
      drawn = [];
    },
  };
}

/** The whole terminal, as `top` uses it. The first draw switches to the alternate screen; every draw writes the block
 * from the top-left corner, fitted to the size read at that draw: each line cut to the width by display width (wide
 * characters count twice), and a block taller than the screen keeps its first rows and says how many it left out. So a
 * resize never touches anything else on the screen. `close` switches back to the main screen, as it was, and writes
 * the last block there, whole, so it stays once the watch ends. */
export function screenView(
  write: (text: string) => void,
  size: () => TerminalSize,
) {
  let block: readonly string[] | undefined;
  let shown: string | undefined;
  return {
    draw(lines: readonly string[]) {
      const { columns, rows } = size();
      const room = Math.max(rows, 1);
      const kept =
        lines.length > room
          ? [
              ...lines.slice(0, room - 1),
              `… ${lines.length - room + 1} more rows; enlarge the window to see them`,
            ]
          : lines;
      // The last row ends without a newline, so a block as tall as the screen never scrolls it.
      const text = kept.map((line) => fitted(line, columns)).join("\n");
      // A resize redraws even an unchanged block: the terminal may have cut or moved what was on the screen.
      const next = `${columns}x${rows}\n${text}`;
      if (next !== shown)
        write(`${block ? "" : "\x1b[?1049h"}\x1b[H\x1b[J${text}`);
      block = lines;
      shown = next;
    },
    close() {
      if (!block) return;
      const { columns } = size();
      write(
        `\x1b[?1049l${block.map((line) => `${fitted(line, columns)}\n`).join("")}`,
      );
      block = undefined;
      shown = undefined;
    },
  };
}

/** Pure: `text` cut to take fewer than `width` terminal cells (so it never wraps), ending in `…` when cut. */
export function fitted(text: string, width: number): string {
  if (Bun.stringWidth(text) < width) return text;
  if (width < 2) return "";
  let kept = "";
  let used = 0;
  for (const character of text) {
    used += Bun.stringWidth(character);
    if (used > width - 2) break;
    kept += character;
  }
  return `${kept}…`;
}

/** Pure: `text` padded with spaces to `width` terminal cells, on the right (`end`) or the left (`start`). */
export function padded(
  text: string,
  width: number,
  side: "start" | "end",
): string {
  const room = " ".repeat(Math.max(width - Bun.stringWidth(text), 0));
  return side === "end" ? text + room : room + text;
}
