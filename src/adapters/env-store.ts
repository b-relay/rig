import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { RigError } from "../domain/errors";
import type { TargetRole } from "../config/schema";
import { parseEnvironmentFile } from "./env-file";
import {
  editEnvText,
  envKeys,
  envRevision,
  type EnvChange,
} from "./env-file-edit";

/** Which operator env file: the Project's or one Service's, for every role (`all.env`) or one role. */
export interface EnvScope {
  service?: string;
  role?: TargetRole;
}
/** What the dashboard may know of an env file without its values. */
export interface EnvFileView {
  scope: EnvScope;
  path: string;
  exists: boolean;
  /** What a write must name to replace this content; `absent` for a file that does not exist. */
  revision: string;
  /** The names it assigns, in file order. */
  keys: string[];
  /** Permission bits, such as 0o600. */
  mode?: number;
  /** Why the file cannot be read or edited: a line the reader refuses (by number, never its value). */
  problem?: string;
}
/** Pure: the operator file a scope names: `<envRoot>/<project>[/<service>]/<role or all>.env`, the files
 * resolve.ts layers into each invocation's environment. Names are checked by the caller's schema. */
export function envScopeFile(
  envRoot: string,
  project: string,
  scope: EnvScope,
): string {
  return join(
    envRoot,
    project,
    ...(scope.service ? [scope.service] : []),
    `${scope.role ?? "all"}.env`,
  );
}
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RigError(
      "ENV_FILE",
      `The environment file ${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`,
      "Make it a readable file and retry.",
      { path },
    );
  }
}
const problemOf = (text: string, path: string): string | undefined => {
  try {
    parseEnvironmentFile(text, path);
    return undefined;
  } catch (error) {
    // The reader's messages name the path and line, never a value.
    return error instanceof RigError ? error.message : "It cannot be parsed.";
  }
};
/** The file a scope names, described without its values. */
export async function describeEnvFile(
  path: string,
  scope: EnvScope,
): Promise<EnvFileView> {
  const text = await readText(path);
  if (text === undefined)
    return {
      scope,
      path,
      exists: false,
      revision: envRevision(undefined),
      keys: [],
    };
  const mode = (await stat(path)).mode & 0o777;
  const problem = problemOf(text, path);
  return {
    scope,
    path,
    exists: true,
    revision: envRevision(text),
    keys: envKeys(text),
    mode,
    ...(problem ? { problem } : {}),
  };
}
/** One value of the file, for a signed-in operator who asked to see it. */
export async function revealEnvValue(
  path: string,
  key: string,
): Promise<string> {
  const text = await readText(path);
  const values = text === undefined ? {} : parseEnvironmentFile(text, path);
  if (!Object.hasOwn(values, key))
    throw new RigError(
      "ENV_KEY_MISSING",
      `${path} does not assign ${key}.`,
      "Reload the page; the file may have changed.",
      { path, key },
    );
  return values[key]!;
}
/** Applies `changes` to the file if it still has `expectedRevision`, keeping its comments and order. The new
 * content is written to a private temporary file beside it and renamed over it, so a reader sees the old file
 * or the new one, never part of either; the file and its directories are only ever the operator's (0600, 0700).
 * Errors name the path, a key or a line number, never a value. */
export async function writeEnvFile(
  path: string,
  scope: EnvScope,
  expectedRevision: string,
  changes: readonly EnvChange[],
): Promise<EnvFileView> {
  const current = await readText(path);
  if (envRevision(current) !== expectedRevision)
    throw new RigError(
      "ENV_REVISION_CONFLICT",
      `${path} changed since it was read.`,
      "Reload the page to read the current file, then make the change again.",
      { path },
    );
  if (current !== undefined) {
    const problem = problemOf(current, path);
    if (problem)
      throw new RigError(
        "ENV_FILE",
        problem,
        "Fix that line in an editor first; the dashboard does not rewrite a file it cannot read.",
        { path },
      );
  }
  const next = editEnvText(current ?? "", changes);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(next);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new RigError(
      "ENV_WRITE",
      `${path} could not be written (${(error as NodeJS.ErrnoException).code ?? "error"}).`,
      "Check that the Rig root's env directory is writable by this user.",
      { path },
    );
  }
  // The rename is durable once the directory entry is.
  const directory = await open(dirname(path), "r").catch(() => undefined);
  await directory?.sync().catch(() => {});
  await directory?.close();
  await chmod(path, 0o600);
  return describeEnvFile(path, scope);
}
