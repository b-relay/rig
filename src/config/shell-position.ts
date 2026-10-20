/** Where a reference sits in text /bin/sh -c will run: bare, inside the author's `'...'` or `"..."`, or a place Rig refuses
 * with what to write instead. Rig never pastes a value into the text, so a wrong reading of the shell here gives a wrong
 * word at worst, never code; it decides only how the variable that carries the value is written. */
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

/** The position at the end of `prefix`, raw config text in which `${...}` is a reference and `$${` a shell `${`. `$(...)`
 * and `(...)` each start a command with no quote open. Refused: in or after a heredoc, whose body Rig does not read; inside
 * `$'...'`; and right after a backslash, which would escape the quote Rig writes. */
export function shellPosition(prefix: string): ShellPosition {
  // The open quote of each nested command, innermost last.
  const quotes: ("'" | '"' | "$'" | undefined)[] = [undefined];
  let wordStart = true;
  const at = (i: number, text: string) => prefix.startsWith(text, i);
  for (let i = 0; i < prefix.length; i++) {
    const quote = quotes.at(-1);
    const char = prefix[i]!;
    const close = () => (quotes[quotes.length - 1] = undefined);
    if (quote === "'") {
      if (char === "'") close();
      continue;
    }
    if (quote === "$'") {
      if (char === "\\") i++;
      else if (char === "'") close();
      continue;
    }
    if (char === "\\") {
      if (i + 1 === prefix.length)
        return refused(
          "after a backslash",
          "Remove the backslash; $${NAME} writes a literal ${NAME}.",
        );
      wordStart = false;
      i++;
      continue;
    }
    if (char === "$") {
      wordStart = false;
      if (at(i, "$${")) i++;
      else if (at(i, "${")) {
        // A reference before this one, which Rig writes as one quoted word part.
        const end = prefix.indexOf("}", i);
        i = end === -1 ? prefix.length : end;
      } else if (at(i, "$(")) {
        quotes.push(undefined);
        wordStart = true;
        i++;
      } else if (at(i, "$'") && quote === undefined) {
        quotes[quotes.length - 1] = "$'";
        i++;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') close();
      continue;
    }
    if (char === "'" || char === '"') {
      quotes[quotes.length - 1] = char;
      wordStart = false;
      continue;
    }
    if (char === "#" && wordStart) {
      const end = prefix.indexOf("\n", i);
      i = end === -1 ? prefix.length : end - 1;
      continue;
    }
    if (char === "<" && at(i, "<<") && !at(i, "<<<"))
      return refused(
        "in or after a heredoc (<<)",
        'Declare it in environment, such as NAME: ${...}, and write $NAME in the heredoc and "$NAME" after it.',
      );
    if (char === "(") quotes.push(undefined);
    else if (char === ")" && quotes.length > 1) quotes.pop();
    if (char === "<") i += at(i, "<<<") ? 2 : 0;
    wordStart = /[\s;&|<>(]/.test(char);
  }
  const quote = quotes.at(-1);
  if (quote === "$'")
    return refused("inside $'...'", "Put it inside '...' or \"...\" instead.");
  return { kind: "word", quote };
}

/** Constructs where bash evaluates text as an arithmetic expression, or a value as a variable name, either of which runs the
 * commands of an array subscript inside it, even from a variable's value. Matched coarsely on the command as the shell
 * joins its words (see evaluatingConstruct). */
const EVALUATING: readonly [RegExp, string][] = [
  [/\(\(|\$\[/, "arithmetic"],
  [/\[\[/, "[[ ... ]]"],
  [/[A-Za-z0-9_}\]]\[/, "a subscript"],
  [/\$\$\{(?:!|[^}]*:(?![-=+?]))/, "an indirect or substring expansion"],
  [
    /(?:^|[\s;&|(`{])(?:let|declare|typeset|local|read|readarray|mapfile|unset)(?=$|[\s;&|)])/,
    "a command that takes variable names",
  ],
  [/(?:^|[\s;&|(`{])printf\s+-v/, "a command that takes variable names"],
];

/** What in `command` bash may evaluate as arithmetic or a variable name, or undefined when there is nothing such. It is
 * matched with line continuations joined and every quote and backslash removed, as the shell removes them before it
 * recognizes `a[`, `((` or a command name such as l""et or \let; that may join what the shell keeps apart, which only
 * refuses more. */
export function evaluatingConstruct(command: string): string | undefined {
  const joined = command.replace(/\\\r?\n/g, "").replace(/['"\\]/g, "");
  return EVALUATING.find(([pattern]) => pattern.test(joined))?.[1];
}
