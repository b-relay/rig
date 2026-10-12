/** A terminal's size now, in character cells. `rows` is absent where only the width matters. */
export interface TerminalSize {
  readonly columns: number;
  readonly rows?: number;
}

/** A block of terminal lines redrawn in place: each draw moves up over the lines the last one wrote, clears to the end
 * of the screen and writes the new ones. The size is read at every draw: lines are cut to the width by display width
 * (wide characters count twice), so each takes exactly one row; a block taller than the screen keeps its first rows and
 * says how many it left out, so the cursor never has to move above the screen; after a resize, whose rewrapping would
 * leave the old lines out of reach, the screen is cleared and the block drawn from the top. An unchanged block is not
 * written again. */
export function liveRegion(
  write: (text: string) => void,
  size: () => TerminalSize = () => ({ columns: 80 }),
) {
  let drawn: string[] = [];
  let drawnColumns: number | undefined;
  return {
    draw(lines: readonly string[]) {
      const { columns, rows } = size();
      const shown =
        rows !== undefined && lines.length > rows - 1
          ? [
              ...lines.slice(0, Math.max(rows - 2, 0)),
              `… ${lines.length - Math.max(rows - 2, 0)} more rows; enlarge the window to see them`,
            ]
          : lines;
      const next = shown.map((line) => fitted(line, columns));
      const resized = drawnColumns !== undefined && drawnColumns !== columns;
      if (!resized && next.join("\n") === drawn.join("\n")) return;
      // Up to the region's first row, then clear to the end of the screen before writing it again; after a resize,
      // the whole screen from the top.
      const erase = resized
        ? "\x1b[H\x1b[2J"
        : drawn.length
          ? `\x1b[${drawn.length}A\r\x1b[J`
          : "";
      write(`${erase}${next.map((line) => `${line}\n`).join("")}`);
      drawn = next;
      drawnColumns = columns;
    },
    /** Leaves the drawn lines as they are, after other text was written below them: the next draw starts afresh. */
    release() {
      drawn = [];
    },
  };
}

/** Pure: `text` cut to fit `width` terminal cells, ending in `…` when cut. */
export function fitted(text: string, width: number): string {
  if (Bun.stringWidth(text) < width) return text;
  let kept = "";
  for (const character of text) {
    if (Bun.stringWidth(kept + character) > Math.max(width - 2, 1)) break;
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
