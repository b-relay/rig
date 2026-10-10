import { createHash } from "node:crypto";
import { RigError } from "../domain/errors";
import { parseEnvironmentFile } from "./env-file";

/** A name an env file may assign, as the env-file reader accepts it. */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** One change to an env file: set a name to a value, or remove every assignment of it. */
export type EnvChange =
  { op: "set"; key: string; value: string } | { op: "remove"; key: string };
/** The revision of a file that does not exist yet; a write against it creates the file. */
export const ABSENT_REVISION = "absent";

/** Pure: the revision of an env file's text, or of no file at all. A write names the revision it read, so
 * a file changed in between is refused rather than overwritten. */
export function envRevision(text: string | undefined): string {
  return text === undefined
    ? ABSENT_REVISION
    : createHash("sha256").update(text).digest("hex");
}
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
/** Pure: the names a file assigns, in the order they first appear. Comments and blank lines are skipped. */
export function envKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const key = ASSIGNMENT.exec(line)?.[1];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}
/** Pure: `KEY=value` as one line the env-file reader reads back to exactly `value`. A value without a single
 * quote or a line break is single-quoted, which the reader takes literally; anything else is double-quoted
 * with escapes. A value the reader cannot read back exactly is refused, naming the key and never the value. */
export function encodeEnvAssignment(key: string, value: string): string {
  if (!ENV_KEY.test(key))
    throw new RigError(
      "ENV_KEY",
      `${JSON.stringify(key)} is not a name an env file can assign.`,
      "Use letters, digits and underscores, starting with a letter or underscore, such as API_KEY.",
      { key },
    );
  const line =
    !value.includes("'") && !/[\r\n]/.test(value)
      ? `${key}='${value}'`
      : `${key}="${value
          .replaceAll("\\", "\\\\")
          .replaceAll('"', '\\"')
          .replaceAll("\n", "\\n")
          .replaceAll("\r", "\\r")}"`;
  let read: string | undefined;
  try {
    read = parseEnvironmentFile(line, "value")[key];
  } catch {
    read = undefined;
  }
  if (read !== value)
    throw new RigError(
      "ENV_VALUE",
      `The value for ${key} cannot be written to an env file so that it reads back the same.`,
      "A value holding both a line break and a backslash, or a single quote and a backslash before n, r or a quote, has no single-line form. Store it another way, for example base64-encoded.",
      { key },
    );
  return line;
}
/** Pure: `text` with `changes` applied, line by line, so comments, order and every other assignment stay as
 * they were. Setting a name replaces its first assignment and drops any later ones (the last would win
 * otherwise); a new name is appended. Removing a name drops every assignment of it. The result ends with a
 * newline unless it is empty. */
export function editEnvText(
  text: string,
  changes: readonly EnvChange[],
): string {
  let lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
  for (const change of changes) {
    if (!ENV_KEY.test(change.key))
      throw new RigError(
        "ENV_KEY",
        `${JSON.stringify(change.key)} is not a name an env file can assign.`,
        "Use letters, digits and underscores, starting with a letter or underscore, such as API_KEY.",
        { key: change.key },
      );
    const assigns = (line: string) =>
      !line.trimStart().startsWith("#") &&
      ASSIGNMENT.exec(line)?.[1] === change.key;
    if (change.op === "remove") {
      lines = lines.filter((line) => !assigns(line));
      continue;
    }
    const encoded = encodeEnvAssignment(change.key, change.value);
    const first = lines.findIndex(assigns);
    if (first < 0) lines.push(encoded);
    else
      lines = lines.flatMap((line, index) =>
        index === first ? [encoded] : assigns(line) ? [] : [line],
      );
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
