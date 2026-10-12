/** A block of terminal lines redrawn in place: each draw moves up over the lines the last one wrote, clears to the end
 * of the screen and writes the new ones. Lines are cut to `columns`, so a redraw always moves up exactly the rows it
 * drew; an unchanged block is not written again. */
export function liveRegion(write: (text: string) => void, columns = 80) {
  let drawn: string[] = [];
  const fit = (line: string) =>
    line.length < columns
      ? line
      : `${line.slice(0, Math.max(columns - 2, 1))}…`;
  return {
    draw(lines: readonly string[]) {
      const next = lines.map(fit);
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
