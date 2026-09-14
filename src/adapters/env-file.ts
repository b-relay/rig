import { readFile } from "node:fs/promises";
import { RigError } from "../domain/errors";

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
        "A deployed Target reads its envFile from the checked-out revision, so a gitignored file is absent there: commit it, declare the values in env for that lane, or remove envFile.",
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
