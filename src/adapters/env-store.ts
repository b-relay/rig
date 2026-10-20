import { chmod, lstat, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { RigError } from "../domain/errors";
import { replacePrivateFile } from "../providers/private-files";
import type { TargetRole } from "../config/schema";
import { parseEnvironmentFile } from "./env-file";
import {
  editEnvText,
  envKeys,
  envRevision,
  type EnvChange,
} from "./env-file-edit";

/** Which operator env file: the Project's, one Service's or one Job's, for every role (`all.env`) or one role. A
 * Service and a Job never share a name, so each owns `<project>/<name>/`. */
export interface EnvScope {
  service?: string;
  job?: string;
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
/** Pure: the operator file a scope names: `<envRoot>/<project>[/<service or job>]/<role or all>.env`, the files
 * resolve.ts layers into each invocation's environment. Names are checked by the caller's schema. */
export function envScopeFile(
  envRoot: string,
  project: string,
  scope: EnvScope,
): string {
  const owner = scope.service ?? scope.job;
  return join(
    envRoot,
    project,
    ...(owner ? [owner] : []),
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
/** One value of the file, for a signed-in operator who asked to see it, with the revision it was read from, so a page
 * never shows it beside a newer file. */
export async function revealEnvValue(
  path: string,
  key: string,
): Promise<{ value: string; revision: string }> {
  const text = await readText(path);
  const values = text === undefined ? {} : parseEnvironmentFile(text, path);
  if (!Object.hasOwn(values, key))
    throw new RigError(
      "ENV_KEY_MISSING",
      `${path} does not assign ${key}.`,
      "Reload the page; the file may have changed.",
      { path, key },
    );
  return { value: values[key]!, revision: envRevision(text) };
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
  /** The directory every directory down to the file's is kept private under, such as `<RIG_ROOT>/env`. */
  privateRoot?: string,
): Promise<EnvFileView> {
  // Names what the file holds now, never a value, so whoever wrote against the older read sees what moved.
  const conflict = (now: string | undefined) =>
    new RigError(
      "ENV_REVISION_CONFLICT",
      `${path} changed since it was read, so nothing was written: ${now === undefined ? "it no longer exists" : `it now assigns ${envKeys(now).join(", ") || "nothing"}`}.`,
      "Read the file again, check your changes against it, and save them on the current file.",
      { path, revision: envRevision(now) },
    );
  const current = await readText(path);
  if (envRevision(current) !== expectedRevision) throw conflict(current);
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
  // The env tree is the operator's alone: directories they made by hand are made private here, as they always were, before
  // the replacement below checks them and makes what is missing.
  for (const directory of privateDirectories(privateRoot, dirname(path)))
    await chmod(directory, 0o700).catch(() => {});
  // The caller refused symlinks below the env root (assertNoSymlinkBelow), so this replaces the file the scope names.
  try {
    await replacePrivateFile(privateRoot ?? dirname(path), path, next, {
      durable: true,
      // Checked again just before the rename, so an edit saved meanwhile in an editor is not overwritten.
      confirm: async () => {
        const now = await readText(path);
        if (envRevision(now) !== expectedRevision) throw conflict(now);
      },
    });
  } catch (error) {
    // The edit is in place; flushing its directory has always been best effort here.
    if (error instanceof RigError && error.code === "FILE_NOT_DURABLE")
      return describeEnvFile(path, scope);
    if (error instanceof RigError) throw error;
    throw new RigError(
      "ENV_WRITE",
      `${path} could not be written (${(error as NodeJS.ErrnoException).code ?? "error"}).`,
      "Check that the Rig root's env directory is writable by this user.",
      { path },
    );
  }
  return describeEnvFile(path, scope);
}
/** Fails ENV_SCOPE_SYMLINK when `path` is not inside `root`, or when any directory or file below `root` on the way to it is
 * a symlink: reading, revealing or replacing it would reach a file outside the env tree. `root` itself may be a symlink.
 * A component that does not exist yet ends the check, since everything below it is created by Rig. */
export async function assertNoSymlinkBelow(
  root: string,
  path: string,
): Promise<void> {
  const refuse = (at: string) =>
    new RigError(
      "ENV_SCOPE_SYMLINK",
      `${at} is a symlink or lies outside ${root}; the dashboard reads and writes only files inside the env directory.`,
      "Replace the symlink with the real file or directory, or edit that file in an editor.",
      { path: at, root },
    );
  const inside = relative(root, path);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw refuse(path);
  let current = root;
  for (const part of inside.split(sep)) {
    current = join(current, part);
    const info = await lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return;
    if (info.isSymbolicLink()) throw refuse(current);
  }
}
/** Pure: `root` and every directory below it down to `leaf`; nothing when `leaf` is not inside `root`. */
export function privateDirectories(
  root: string | undefined,
  leaf: string,
): string[] {
  if (!root) return [];
  const inside = relative(root, leaf);
  if (inside.startsWith("..") || isAbsolute(inside)) return [];
  const parts = inside ? inside.split(sep) : [];
  return [
    root,
    ...parts.map((_, index) => join(root, ...parts.slice(0, index + 1))),
  ];
}
