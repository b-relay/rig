import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { RigError } from "../domain/errors";
import type { EnvFileRef } from "../config/types";
import {
  REFERENCE_VARIABLE_PREFIX,
  RESERVED_NAME_RULE,
  unrepresentableValue,
  type LoadedEnvFile,
} from "../domain/process-environment";
import type { CommandRunner } from "../providers/contracts";

/** The name a line assigns, read without its value. */
export const ASSIGNED_NAME = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const LOSSLESS_HINT =
  "Rig hands a process a value exactly or refuses it. Correct that line in an editor: save the file as UTF-8, and keep binary data base64-encoded. A process already running keeps running; whatever reads this file cannot start until then.";

/** Whether Git ignores a path inside a workspace; undefined when the workspace is verified not to be a Git checkout. A tracked file is never ignored.
 * Rejects ENV_FILE_UNVERIFIED when Git is there but cannot answer, so an unchecked file never loads. */
export type IgnoredByGit = (
  workspace: string,
  path: string,
) => Promise<boolean | undefined>;
export function gitIgnoreCheck(
  run: CommandRunner,
  env: Readonly<Record<string, string>>,
): IgnoredByGit {
  return async (workspace, path) => {
    const result = await run({
      command: ["git", "check-ignore", "-q", "--", path],
      cwd: workspace,
      env: { ...env },
      timeoutMs: 10_000,
    });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    const checkout = await run({
      command: ["git", "rev-parse", "--is-inside-work-tree"],
      cwd: workspace,
      env: { ...env, LC_ALL: "C" },
      timeoutMs: 10_000,
    });
    if (
      checkout.exitCode !== 0 &&
      /not a git repository/i.test(checkout.stderr)
    )
      return undefined;
    throw new RigError(
      "ENV_FILE_UNVERIFIED",
      `Git could not say whether ${path} is ignored.`,
      "An env file inside a repository loads only once Git confirms it is ignored. Run git check-ignore on it in that repository and fix what Git reports, or keep the file outside the repository.",
      { path, exitCode: result.exitCode },
    );
  };
}
/** Loads one invocation's env files in order. A listed file must exist (ENV_FILE_MISSING); an optional one is skipped when absent.
 * A file inside the workspace that Git does not ignore is refused as ENV_FILE_TRACKED before it is read.
 * `warnings` name files other users can access. Contents go to the caller only; no error or warning carries a value.
 * `forRunningProcess` is for a command that checks a process already running, which must not fail for a value it was started
 * with before Rig refused such values: a file `parseEnvironmentFile` refuses for one is read as it always was, with a warning. */
export async function loadEnvironmentFiles(
  refs: readonly EnvFileRef[],
  workspace: string,
  ignored: IgnoredByGit,
  forRunningProcess = false,
): Promise<{ files: LoadedEnvFile[]; warnings: string[] }> {
  const files: LoadedEnvFile[] = [],
    warnings: string[] = [];
  for (const ref of refs) {
    const info = await stat(ref.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !ref.required) return undefined;
      return error;
    });
    if (info === undefined) continue;
    if (!(info instanceof Error)) {
      const inside = relative(workspace, ref.path);
      if (
        inside !== "" &&
        !inside.startsWith("..") &&
        !isAbsolute(inside) &&
        (await ignored(workspace, ref.path)) === false
      )
        throw new RigError(
          "ENV_FILE_TRACKED",
          `The environment file ${ref.path} is inside the repository and Git does not ignore it.`,
          "Env files hold operator values: add the path to .gitignore and stop tracking it, or keep the file outside the repository, for example under ~/.rig/env/<project>/.",
          { path: ref.path },
        );
      if (info.mode & 0o077)
        warnings.push(
          `Environment file ${ref.path} is accessible to other users (mode ${(info.mode & 0o777).toString(8).padStart(3, "0")}); run chmod 600 on it.`,
        );
    }
    files.push({
      path: ref.path,
      values: await readEnvironmentFile(
        ref.path,
        forRunningProcess
          ? (refusal) =>
              warnings.push(
                `${refusal} What already runs keeps running; what reads this file cannot start until that line is fixed.`,
              )
          : undefined,
      ),
    });
  }
  return { files, warnings };
}

/** Reads a dotenv-style file for a Target. A file that does not exist is ENV_FILE_MISSING, one that cannot be read is ENV_FILE,
 * each parse rejection names the path and line, and a value Rig cannot pass on exactly is ENV_VALUE. With `tolerated`, ENV_VALUE
 * is told to it instead and the file reads as it did before such values were refused: bytes that are not UTF-8 replaced, and
 * what no process could get left out. */
export async function readEnvironmentFile(
  path: string,
  tolerated?: (refusal: string) => void,
): Promise<Record<string, string>> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new RigError(
        "ENV_FILE_MISSING",
        `The environment file ${path} does not exist.`,
        "A listed env_file is required. A deployed Target resolves a relative path inside its checked-out Commit, where an ignored file is absent: provide the values under ~/.rig/env/<project>/, or list an absolute or ~/ path outside the repository. Never commit a file that holds secrets.",
        { path },
      );
    throw new RigError(
      "ENV_FILE",
      `The environment file ${path} cannot be read (${code ?? String(error)}).`,
      "Make it a readable file and retry.",
      { path, cause: code ?? String(error) },
    );
  }
  try {
    return parseEnvironmentFile(decodeEnvironmentFile(bytes, path), path);
  } catch (error) {
    if (!tolerated || (error as RigError).code !== "ENV_VALUE") throw error;
    tolerated((error as RigError).message);
    return parseEnvironmentFile(lossyEnvironmentText(bytes), path, "skip");
  }
}

/** A BOM stays in the text, where the parser reads it as leading space and an edit keeps it. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });
/** Pure: a file's bytes as text with anything that is not UTF-8 replaced, for what never depends on a value, such as its names. */
export function lossyEnvironmentText(bytes: Uint8Array): string {
  return lossyUtf8.decode(bytes);
}
/** Pure: a file's bytes as exactly the text they hold, or ENV_VALUE naming the path, the first line that is not UTF-8 and
 * the name it assigns, never a value. */
export function decodeEnvironmentFile(bytes: Uint8Array, path: string): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    const line = invalidLine(bytes);
    const key = ASSIGNED_NAME.exec(line.text)?.[1];
    throw new RigError(
      "ENV_VALUE",
      `The environment file ${path} has bytes that are not valid UTF-8 on line ${line.number}${key ? `, in the assignment of ${key}` : ""}.`,
      LOSSLESS_HINT,
      { path, line: line.number, ...(key ? { key } : {}) },
    );
  }
}
/** The first line of `bytes` that is not UTF-8, which holds its first invalid byte: no multi-byte sequence holds a newline. */
function invalidLine(bytes: Uint8Array): { number: number; text: string } {
  let start = 0;
  for (let number = 1; ; number++) {
    const end = bytes.indexOf(0x0a, start);
    const line = bytes.subarray(start, end < 0 ? bytes.length : end);
    try {
      strictUtf8.decode(line);
    } catch {
      return { number, text: lossyEnvironmentText(line) };
    }
    start = end + 1;
  }
}

/** dotenv-style single-line assignments: `KEY=value`, optional `export`, single or double
 * quotes, and a `# comment` after the value (after the closing quote of a quoted one).
 * Unsupported syntax is rejected by path and line instead of silently altering secrets, and as ENV_VALUE, naming the name too,
 * an assignment whose value could not reach a process exactly; `unrepresentable: "skip"` leaves such an assignment out instead. */
export function parseEnvironmentFile(
  text: string,
  path: string,
  unrepresentable: "refuse" | "skip" = "refuse",
): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const reject = (problem: string, hint: string, key?: string) =>
      new RigError(
        key === undefined ? "ENV_FILE" : "ENV_VALUE",
        `The environment file ${path} has ${problem} on line ${index + 1}.`,
        hint,
        { path, line: index + 1, ...(key === undefined ? {} : { key }) },
      );
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(
      line,
    );
    if (!match)
      throw reject(
        "an unsupported assignment",
        "Use one KEY=value assignment per line; a bare KEY without = is not an assignment.",
      );
    const key = match[1]!;
    if (key.startsWith(REFERENCE_VARIABLE_PREFIX))
      throw reject(
        `the reserved name ${key}`,
        `Rename it: ${RESERVED_NAME_RULE}.`,
      );
    // An environment here is a plain object, where assigning this name keeps nothing.
    if (key === "__proto__") {
      if (unrepresentable === "skip") continue;
      throw reject(
        "the name __proto__, which Rig cannot keep,",
        `Rename it or remove the line; no value under this name has ever reached a process. ${LOSSLESS_HINT}`,
        key,
      );
    }
    const assign = (value: string) => {
      const problem = unrepresentableValue(value);
      if (problem === undefined) values[key] = value;
      else if (unrepresentable === "refuse")
        throw reject(
          `a value for ${key} that holds ${problem},`,
          LOSSLESS_HINT,
          key,
        );
    };
    const raw = match[2]!.trim();
    const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : undefined;
    if (!quote) {
      assign(raw.replace(/\s+#.*$/, "").trimEnd());
      continue;
    }
    const closing = closingQuote(raw, quote);
    if (closing < 0)
      throw reject(
        "an unmatched quote",
        "Close the quote on the same line; a value cannot span lines.",
      );
    const rest = raw.slice(closing + 1).trim();
    if (rest && !rest.startsWith("#"))
      throw reject(
        "text after the closing quote",
        "Put a space and # before a trailing comment, or quote the whole value.",
      );
    const inner = raw.slice(1, closing);
    assign(
      quote === '"'
        ? // One pass, so an escaped backslash before n, r or a quote stays a backslash and that letter.
          inner.replace(/\\([nr"\\])/g, (_escape, letter: string) =>
            letter === "n" ? "\n" : letter === "r" ? "\r" : letter,
          )
        : inner,
    );
  }
  return values;
}
/** Index of the quote that closes the value opened at position 0, or -1; a double-quoted value may escape a quote with a backslash. */
function closingQuote(raw: string, quote: string): number {
  for (let index = 1; index < raw.length; index++) {
    if (quote === '"' && raw[index] === "\\") {
      index++;
      continue;
    }
    if (raw[index] === quote) return index;
  }
  return -1;
}
