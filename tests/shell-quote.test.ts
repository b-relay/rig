import { expect, test } from "bun:test";
import { shellQuote, withinSingleQuotes } from "../src/domain/shell-quote";
import { shellWord } from "../src/domain/target-selector";
import { execCommand } from "../src/config/healthcheck";

/** Words the shell would otherwise read: split, quote, expand, glob, assign or path-expand (zsh's leading `=`). */
const WORDS = [
  "",
  "plain",
  "two words",
  "it's",
  "''",
  "'",
  'say "hi"',
  "line\nbreak",
  "$HOME",
  "${HOME}",
  "`id`",
  "$(id)",
  "*",
  "[ab]?",
  "~",
  "A=1",
  "=ls",
  "-n",
  "a\\b",
  "tab\there",
  "end'",
];
/** The argv /bin/sh hands a program for `words`, read back NUL-separated so no word is ambiguous. */
function argvOf(words: string): string[] {
  const result = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\\0' ${words}`]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\0").slice(0, -1);
}

test("a quoted word reaches a program as exactly the value, whatever the shell would read in it", () => {
  expect(argvOf(WORDS.map(shellQuote).join(" "))).toEqual(WORDS);
});

test("a value written between the author's single quotes reaches a program as exactly the value", () => {
  expect(
    argvOf(WORDS.map((word) => `'${withinSingleQuotes(word)}'`).join(" ")),
  ).toEqual(WORDS);
  expect(argvOf(`'before ${withinSingleQuotes("it's")} after'`)).toEqual([
    "before it's after",
  ]);
});

test("a word is always quoted, and a quote inside it closes, escapes and reopens the quotes", () => {
  expect(shellQuote("")).toBe("''");
  expect(shellQuote("plain")).toBe("'plain'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
  expect(withinSingleQuotes("it's")).toBe("it'\\''s");
  expect(withinSingleQuotes("plain")).toBe("plain");
});

test("every quoting owner built on it keeps its own policy and still round-trips through /bin/sh", () => {
  // shellWord leaves a plain word bare and quotes the rest; execCommand quotes every word, the program included.
  expect(shellWord("feature/x")).toBe("feature/x");
  expect(shellWord("=ls")).toBe("'=ls'");
  expect(argvOf(WORDS.map(shellWord).join(" "))).toEqual(WORDS);
  expect(execCommand(["printf", "%s", "it's"])).toBe(
    "'printf' '%s' 'it'\\''s'",
  );
});
