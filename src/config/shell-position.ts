/** Where a reference sits in text /bin/sh -c will run, as far as Rig must know to insert a value there as literal data. A
 * `word` is part of an ordinary shell word, bare or inside the author's quote; `arithmetic` is inside `$((...))` or
 * `((...))` and `test` inside `[[ ... ]]`, where bash may evaluate a word as an arithmetic expression; `refused` is a place
 * Rig cannot keep a value literal, with what it is and what to write instead. */
export type ShellPosition =
  | { kind: "word"; quote: "'" | '"' | undefined }
  | { kind: "arithmetic" }
  | { kind: "test" }
  | { kind: "refused"; place: string; hint: string };

const VIA_ENVIRONMENT =
  'Declare it in environment, such as NAME: ${...}, and write "$NAME" instead.';
/** Each place no quoting keeps a value literal, short enough to sit in a config issue with its remedy. */
const REFUSED = {
  heredoc: { place: "in a heredoc", hint: VIA_ENVIRONMENT },
  ansi: {
    place: "inside $'...'",
    hint: "Put it inside '...' or \"...\" instead.",
  },
  comment: {
    place: "in a comment",
    hint: "Remove it from the comment, or write $${...} for literal text.",
  },
  escape: {
    place: "after a backslash",
    hint: "Remove the backslash; $${NAME} writes a literal ${NAME}.",
  },
  backquote: {
    place: "inside backquotes",
    hint: "Write the command substitution as $(...) instead of backquotes.",
  },
} as const;
type Frame = {
  /** A command of its own; `$((`/`((` arithmetic; a parenthesis inside arithmetic. */
  kind: "command" | "arithmetic" | "group";
  quote: "'" | '"' | "$'" | undefined;
  /** Inside `[[ ... ]]`. */
  test: boolean;
};
type Heredoc = { delimiter: string; strip: boolean; expands: boolean };
const BLANK = /[ \t]/;
const SEPARATOR = /[\s;&|()<>]/;

/** The position at the end of `prefix`, raw config text in which `${...}` is a reference already resolved to one literal word
 * part and `$${` a shell `${`. Nested `$(...)` and `(...)` each start a command with no quote open. Anything Rig cannot follow
 * with certainty, such as a `case` inside `$(...)` or a heredoc it cannot find the end of, refuses every later reference. */
export function shellPosition(prefix: string): ShellPosition {
  const frames: Frame[] = [{ kind: "command", quote: undefined, test: false }];
  const heredocs: Heredoc[] = [];
  let backquoted = false;
  let wordStart = true;
  /** How many frames were open where the pending heredocs started. */
  let depth = 1;
  const lost = (what: string): ShellPosition => ({
    kind: "refused",
    place: `after ${what}`,
    hint: VIA_ENVIRONMENT,
  });
  const at = (i: number, text: string) => prefix.startsWith(text, i);
  const ends = (i: number) => i >= prefix.length || SEPARATOR.test(prefix[i]!);
  for (let i = 0; i < prefix.length; i++) {
    const frame = frames.at(-1)!;
    const char = prefix[i]!;
    if (frame.quote === "'") {
      if (char === "'") frame.quote = undefined;
      continue;
    }
    if (frame.quote === "$'") {
      if (char === "\\") i++;
      else if (char === "'") frame.quote = undefined;
      continue;
    }
    if (char === "\\") {
      if (i + 1 === prefix.length)
        return { kind: "refused", ...REFUSED.escape };
      // An escaped newline joins two lines and is no part of a word.
      if (prefix[i + 1] !== "\n") wordStart = false;
      i++;
      continue;
    }
    if (char === "`") {
      backquoted = !backquoted;
      wordStart = false;
      continue;
    }
    if (char === "$") {
      wordStart = false;
      if (at(i, "$${")) i += 1;
      else if (at(i, "${")) {
        // A reference resolved before this one: one literal word part.
        const close = prefix.indexOf("}", i);
        i = close === -1 ? prefix.length : close;
      } else if (at(i, "$((")) {
        frames.push({ kind: "arithmetic", quote: undefined, test: false });
        i += 2;
      } else if (at(i, "$(")) {
        frames.push({ kind: "command", quote: undefined, test: false });
        wordStart = true;
        i += 1;
      } else if (at(i, "$'") && frame.quote === undefined) {
        frame.quote = "$'";
        i += 1;
      }
      continue;
    }
    if (frame.quote === '"') {
      if (char === '"') frame.quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      frame.quote = char;
      wordStart = false;
      continue;
    }
    if (frame.kind !== "command") {
      if (char === "(")
        frames.push({ kind: "group", quote: undefined, test: false });
      else if (char === ")") {
        if (frame.kind === "arithmetic" && prefix[i + 1] === ")") i++;
        if (frames.length > 1) frames.pop();
      }
      continue;
    }
    if (char === "\n") {
      wordStart = true;
      if (!heredocs.length) continue;
      if (depth !== frames.length || backquoted)
        return lost("a heredoc Rig cannot follow");
      const end = heredocBodiesEnd(prefix, i + 1, heredocs.splice(0));
      if (end === undefined) return { kind: "refused", ...REFUSED.heredoc };
      i = end;
      continue;
    }
    if (BLANK.test(char) || /[;&|]/.test(char)) {
      wordStart = true;
      continue;
    }
    if (char === "#" && wordStart) {
      const end = prefix.indexOf("\n", i);
      if (end === -1) return { kind: "refused", ...REFUSED.comment };
      // The newline that ends the comment may start a heredoc's body.
      i = end - 1;
      continue;
    }
    if (char === "<" && at(i, "<<") && !at(i, "<<<")) {
      const operator = heredocOperator(prefix, i);
      if (operator === "unfinished")
        return { kind: "refused", ...REFUSED.heredoc };
      if (operator === undefined) return lost("a heredoc with no delimiter");
      if (heredocs.length && depth !== frames.length)
        return lost("a heredoc Rig cannot follow");
      depth = frames.length;
      heredocs.push(operator.heredoc);
      i = operator.end - 1;
      wordStart = true;
      continue;
    }
    if (char === "<" || char === ">") {
      if (at(i, "<<<")) i += 2;
      wordStart = true;
      continue;
    }
    if (char === "(") {
      if (wordStart && at(i, "((")) {
        frames.push({ kind: "arithmetic", quote: undefined, test: false });
        i++;
      } else
        frames.push({ kind: "command", quote: undefined, test: frame.test });
      wordStart = true;
      continue;
    }
    if (char === ")") {
      if (frames.length > 1) frames.pop();
      wordStart = false;
      continue;
    }
    if (wordStart) {
      // A `case` pattern's `)` would end a `$(...)` or `(...)` early in Rig's reading.
      if (at(i, "case") && ends(i + 4) && frames.length > 1)
        return lost("a case inside $(...) or (...)");
      if (at(i, "[[") && ends(i + 2)) frame.test = true;
      if (at(i, "]]") && ends(i + 2)) frame.test = false;
    }
    wordStart = false;
  }
  if (backquoted) return { kind: "refused", ...REFUSED.backquote };
  if (heredocs.length) return { kind: "refused", ...REFUSED.heredoc };
  const frame = frames.at(-1)!;
  if (frame.quote === "$'") return { kind: "refused", ...REFUSED.ansi };
  if (frame.kind !== "command") return { kind: "arithmetic" };
  if (frame.test) return { kind: "test" };
  return { kind: "word", quote: frame.quote };
}

/** The heredoc a `<<` or `<<-` at `start` opens and the index after its delimiter word; "unfinished" when `prefix` ends
 * inside the operator or its word, or a reference makes part of the word; undefined when the word is missing. Quote removal gives the delimiter; any quoting in it
 * makes the body literal. */
function heredocOperator(
  prefix: string,
  start: number,
): { heredoc: Heredoc; end: number } | "unfinished" | undefined {
  let i = start + 2;
  const strip = prefix[i] === "-";
  if (strip) i++;
  while (i < prefix.length && BLANK.test(prefix[i]!)) i++;
  let delimiter = "";
  let quoted = false;
  while (i < prefix.length && !SEPARATOR.test(prefix[i]!)) {
    const char = prefix[i]!;
    if (char === "'" || char === '"') {
      const close = prefix.indexOf(char, i + 1);
      if (close === -1) return "unfinished";
      delimiter += prefix.slice(i + 1, close);
      quoted = true;
      i = close + 1;
    } else if (char === "\\") {
      if (i + 1 === prefix.length) return "unfinished";
      delimiter += prefix[i + 1];
      quoted = true;
      i += 2;
    } else if (char === "$" && prefix[i + 1] === "{") return "unfinished";
    else {
      delimiter += char;
      i++;
    }
  }
  if (i === prefix.length) return "unfinished";
  if (delimiter === "") return undefined;
  return { heredoc: { delimiter, strip, expands: !quoted }, end: i };
}

/** The index of the newline that ends the last of `heredocs`, whose bodies start at `start` one after another; undefined
 * when `prefix` ends inside one. In an expanding body a line ending in a backslash joins the next, and Rig never takes a
 * joined line as the delimiter, so it never ends a body before the shell does. */
function heredocBodiesEnd(
  prefix: string,
  start: number,
  heredocs: readonly Heredoc[],
): number | undefined {
  let line = start;
  for (const heredoc of heredocs) {
    let joined = false;
    for (;;) {
      const end = prefix.indexOf("\n", line);
      if (end === -1) return undefined;
      const text = prefix.slice(line, end);
      const ended =
        !joined &&
        (heredoc.strip ? text.replace(/^\t+/, "") : text) === heredoc.delimiter;
      joined = heredoc.expands && text.endsWith("\\");
      line = end + 1;
      if (ended) break;
    }
  }
  return line - 1;
}
