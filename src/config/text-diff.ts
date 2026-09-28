/** Lines of context around each change, as `diff -u` shows. */
const CONTEXT = 3;
type Edit = { kind: " " | "-" | "+"; line: string };

/** Pure: a unified diff of two texts by line, with `label` naming the file on both sides; empty when they are equal. A
 * config file is small, so the longest common subsequence is found directly. */
export function unifiedDiff(
  before: string,
  after: string,
  label: string,
): string {
  if (before === after) return "";
  const edits = lineEdits(lines(before), lines(after));
  const hunks: string[] = [];
  let index = 0;
  while (index < edits.length) {
    if (edits[index]!.kind === " ") {
      index++;
      continue;
    }
    // A hunk runs from a change until more than twice the context separates it from the next one.
    const start = Math.max(0, index - CONTEXT);
    let end = index;
    for (;;) {
      while (end < edits.length && edits[end]!.kind !== " ") end++;
      let gap = end;
      while (gap < edits.length && edits[gap]!.kind === " ") gap++;
      if (gap < edits.length && gap - end <= 2 * CONTEXT) end = gap;
      else {
        end = Math.min(edits.length, end + CONTEXT);
        break;
      }
    }
    hunks.push(hunk(edits, start, end));
    index = end;
  }
  return `--- ${label}\n+++ ${label}\n${hunks.join("")}`;
}
function lines(text: string): string[] {
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}
function hunk(edits: readonly Edit[], start: number, end: number): string {
  const position = (kind: "-" | "+") =>
    edits.slice(0, start).filter((edit) => edit.kind !== kind).length;
  const count = (kind: "-" | "+") =>
    edits.slice(start, end).filter((edit) => edit.kind !== kind).length;
  const range = (from: number, size: number) =>
    size === 1 ? `${from + 1}` : `${size ? from + 1 : from},${size}`;
  return `@@ -${range(position("+"), count("+"))} +${range(position("-"), count("-"))} @@\n${edits
    .slice(start, end)
    .map((edit) => `${edit.kind}${edit.line}\n`)
    .join("")}`;
}
/** The shortest edit from `a` to `b` by line: kept lines, then removals before additions at each change. */
function lineEdits(a: readonly string[], b: readonly string[]): Edit[] {
  const common: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i]![j] =
        a[i] === b[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const edits: Edit[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length)
    if (i < a.length && j < b.length && a[i] === b[j]) {
      edits.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (
      j >= b.length ||
      (i < a.length && common[i + 1]![j]! >= common[i]![j + 1]!)
    )
      edits.push({ kind: "-", line: a[i++]! });
    else edits.push({ kind: "+", line: b[j++]! });
  return edits;
}
