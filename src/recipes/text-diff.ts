/** At most this many line pairs (about 16 MiB of table) are compared. */
export const MAX_DIFF_CELLS = 4_000_000;
/** Pure: a line diff of `from` against `to` in unified form without file headers: `@@ -a,b +c,d @@` hunks of lines
 * prefixed `-` (only in `from`), `+` (only in `to`) or ` ` (context), with `context` unchanged lines around each change.
 * Empty when the texts are equal; undefined when they are too long to compare (more than MAX_DIFF_CELLS pairs of lines).
 * Uses the longest common subsequence of lines. */
export function lineDiff(
  from: string,
  to: string,
  context = 3,
): string[] | undefined {
  if (from === to) return [];
  const a = from.split("\n"),
    b = to.split("\n");
  // The table holds a number per pair of lines: past this many, there is no diff, only the fact of a difference.
  if (a.length * b.length > MAX_DIFF_CELLS) return undefined;
  // lengths[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lengths = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  /** Every line of both texts in order, with its kind and its 1-based line numbers. */
  const script: {
    kind: " " | "-" | "+";
    text: string;
    a: number;
    b: number;
  }[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      script.push({ kind: " ", text: a[i]!, a: ++i, b: ++j });
    } else if (
      j >= b.length ||
      (i < a.length && lengths[i + 1]![j]! >= lengths[i]![j + 1]!)
    ) {
      script.push({ kind: "-", text: a[i]!, a: ++i, b: j });
    } else {
      script.push({ kind: "+", text: b[j]!, a: i, b: ++j });
    }
  }
  const changed = script
    .map((line, index) => (line.kind === " " ? -1 : index))
    .filter((index) => index !== -1);
  const hunks: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context),
      end = Math.min(script.length - 1, index + context);
    const last = hunks.at(-1);
    if (last && start <= last[1] + 1) last[1] = end;
    else hunks.push([start, end]);
  }
  return hunks.flatMap(([start, end]) => {
    const lines = script.slice(start, end + 1);
    const inA = lines.filter((line) => line.kind !== "+");
    const inB = lines.filter((line) => line.kind !== "-");
    // A side with no lines in the hunk names the line it follows, as unified diffs do.
    const aStart = inA.length ? inA[0]!.a : lines[0]!.a,
      bStart = inB.length ? inB[0]!.b : lines[0]!.b;
    return [
      `@@ -${aStart},${inA.length} +${bStart},${inB.length} @@`,
      ...lines.map((line) => `${line.kind}${line.text}`),
    ];
  });
}
