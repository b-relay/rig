import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { RigError } from "../domain/errors";
import type { EnvFileRef } from "../config/types";
import type { LoadedEnvFile } from "../domain/process-environment";
import type { CommandRunner } from "../providers/contracts";

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
 * `warnings` name files other users can access. Contents go to the caller only; no error or warning carries a value. */
export async function loadEnvironmentFiles(
  refs: readonly EnvFileRef[],
  workspace: string,
  ignored: IgnoredByGit,
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
    files.push({ path: ref.path, values: await readEnvironmentFile(ref.path) });
  }
  return { files, warnings };
}

/** Reads a dotenv-style file for a Target. A file that does not exist is ENV_FILE_MISSING,
 * one that cannot be read is ENV_FILE, and each parse rejection names the path and line. */
export async function readEnvironmentFile(
  path: string,
): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
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
  return parseEnvironmentFile(text, path);
}

/** dotenv-style single-line assignments: `KEY=value`, optional `export`, single or double
 * quotes, and a `# comment` after the value (after the closing quote of a quoted one).
 * Unsupported syntax is rejected by path and line instead of silently altering secrets. */
export function parseEnvironmentFile(
  text: string,
  path: string,
): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const reject = (problem: string, hint: string) =>
      new RigError(
        "ENV_FILE",
        `The environment file ${path} has ${problem} on line ${index + 1}.`,
        hint,
        { path, line: index + 1 },
      );
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(
      line,
    );
    if (!match)
      throw reject(
        "an unsupported assignment",
        "Use one KEY=value assignment per line; a bare KEY without = is not an assignment.",
      );
    const raw = match[2]!.trim();
    const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : undefined;
    if (!quote) {
      values[match[1]!] = raw.replace(/\s+#.*$/, "").trimEnd();
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
    values[match[1]!] =
      quote === '"'
        ? inner
            .replaceAll("\\n", "\n")
            .replaceAll("\\r", "\r")
            .replaceAll('\\"', '"')
            .replaceAll("\\\\", "\\")
        : inner;
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
