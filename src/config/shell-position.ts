/** Where a reference sits in text /bin/sh -c will run, as far as Rig must know to insert a value there as literal data:
 * part of an ordinary word of a simple command, bare or inside the author's quote, or `refused` with what the place is and
 * what to write instead. */
export type ShellPosition =
  | { kind: "word"; quote: "'" | '"' | undefined }
  | { kind: "refused"; place: string; hint: string };

const VIA_ENVIRONMENT =
  'Declare it in environment, such as NAME: ${...}, and write "$NAME" instead.';
const refused = (place: string, hint = VIA_ENVIRONMENT): ShellPosition => ({
  kind: "refused",
  place,
  hint,
});
type Frame = {
  /** A `(...)` subshell, after which a command may follow, or a `$(...)` substitution, which is part of a word. */
  kind: "subshell" | "substitution";
  quote: "'" | '"' | undefined;
  /** An unquoted `[` is open in the current word: an array subscript, which bash evaluates as arithmetic, or a pattern. */
  subscript: boolean;
};
const BLANK = /[ \t]/;
const SEPARATOR = /[\s;&|()<>]/;
/** Reserved words after which the next word starts a command again. */
const LEADING_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "time",
]);
/** `${...}` Rig reads whole: a name, `#name`, a positional or special parameter, optionally with a default, assignment,
 * alternative or error word made of plain characters. */
const SIMPLE_EXPANSION =
  /^(?:#?[A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])(?::?[-=+?][^'"`$\\{}[\]]*)?$/;

/** The position at the end of `prefix`, raw config text in which `${...}` is a reference already resolved to one literal word
 * part and `$${` a shell `${`. Rig reads only what it models completely: words, quotes, `$(...)` and `(...)` commands,
 * simple `${...}` expansions, redirections, comments, and a line continued after a blank. Anything else before the
 * position, such as a heredoc, arithmetic, `[[`, `case`, `$'...'` or backquotes, refuses it, and so does a position inside
 * a comment, a `[...]` subscript or a `${...}` expansion, or right after a backslash. */
export function shellPosition(prefix: string): ShellPosition {
  const frames: Frame[] = [
    { kind: "subshell", quote: undefined, subscript: false },
  ];
  let wordStart = true;
  let commandStart = true;
  const at = (i: number, text: string) => prefix.startsWith(text, i);
  const ends = (i: number) => i >= prefix.length || SEPARATOR.test(prefix[i]!);
  for (let i = 0; i < prefix.length; i++) {
    const frame = frames.at(-1)!;
    const char = prefix[i]!;
    if (frame.quote === "'") {
      if (char === "'") frame.quote = undefined;
      continue;
    }
    if (char === "\\") {
      if (i + 1 === prefix.length)
        return refused(
          "after a backslash",
          "Remove the backslash; $${NAME} writes a literal ${NAME}.",
        );
      if (prefix[i + 1] === "\n") {
        // A continuation is a blank only between words; anywhere else it joins text the shell then reads as one token.
        if (
          frame.quote !== undefined ||
          !(i === 0 || /\s/.test(prefix[i - 1]!))
        )
          return refused(
            "after a line continued inside a word or quotes",
            "Put a blank before a backslash that continues a line, and keep quoted text on one line.",
          );
        i++;
        continue;
      }
      wordStart = false;
      commandStart = false;
      i++;
      continue;
    }
    if (char === "`")
      return refused(
        "in or after backquotes",
        "Write the command substitution as $(...) instead of backquotes.",
      );
    if (char === "$") {
      wordStart = false;
      commandStart = false;
      if (at(i, "$${")) {
        const close = prefix.indexOf("}", i);
        if (close === -1) return refused("in a ${...} expansion");
        if (!SIMPLE_EXPANSION.test(prefix.slice(i + 3, close)))
          return refused("in or after a ${...} expansion Rig cannot read");
        i = close;
      } else if (at(i, "${")) {
        // A reference resolved before this one: one literal word part.
        const close = prefix.indexOf("}", i);
        i = close === -1 ? prefix.length : close;
      } else if (at(i, "$((") || at(i, "$["))
        return refused("in or after arithmetic");
      else if (at(i, "$(")) {
        frames.push({
          kind: "substitution",
          quote: undefined,
          subscript: false,
        });
        wordStart = true;
        commandStart = true;
        i++;
      } else if (at(i, "$'") && frame.quote === undefined)
        return refused("in or after $'...'");
      continue;
    }
    if (frame.quote === '"') {
      if (char === '"') frame.quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      frame.quote = char;
      wordStart = false;
      commandStart = false;
      continue;
    }
    if (char === "\n" || char === ";" || char === "&" || char === "|") {
      wordStart = true;
      commandStart = true;
      frame.subscript = false;
      continue;
    }
    if (BLANK.test(char)) {
      wordStart = true;
      frame.subscript = false;
      continue;
    }
    if (char === "#" && wordStart) {
      const end = prefix.indexOf("\n", i);
      if (end === -1)
        return refused(
          "in a comment",
          "Remove it from the comment, or write $${...} for literal text.",
        );
      i = end - 1;
      continue;
    }
    if (char === "<" || char === ">") {
      if (at(i, "<<<")) i += 2;
      else if (at(i, "<<")) return refused("in or after a heredoc (<<)");
      wordStart = true;
      frame.subscript = false;
      continue;
    }
    if (char === "(") {
      if (at(i, "((")) return refused("in or after arithmetic");
      frames.push({ kind: "subshell", quote: undefined, subscript: false });
      wordStart = true;
      commandStart = true;
      continue;
    }
    if (char === ")") {
      if (frames.length === 1) return refused("after an unmatched )");
      // After a subshell a keyword may follow, as in `if (...) then`; after a substitution the word goes on.
      commandStart = frames.pop()!.kind === "subshell";
      wordStart = false;
      continue;
    }
    if (char === "[" && at(i, "[[") && ends(i + 2))
      return refused("in or after [[ ... ]]");
    if (wordStart) {
      const word = /^[^\s;&|()<>'"\\`$]*/.exec(prefix.slice(i))![0];
      if (commandStart && word === "case" && ends(i + 4))
        return refused("in or after a case statement");
      // A keyword or an assignment leaves the next word a command; `{` is taken as one wherever it stands alone.
      commandStart = commandStart
        ? (LEADING_KEYWORDS.has(word) && ends(i + word.length)) ||
          /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word)
        : word === "{" && ends(i + 1);
    }
    if (char === "[") frame.subscript = true;
    else if (char === "]") frame.subscript = false;
    wordStart = false;
  }
  // A subscript's value reaches arithmetic, even through the output of a command inside it.
  if (frames.some((frame) => frame.subscript))
    return refused("in a [...] subscript or pattern");
  return { kind: "word", quote: frames.at(-1)!.quote };
}
