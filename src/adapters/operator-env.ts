import type { Stats } from "node:fs";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { RigError, failureReason } from "../domain/errors";
import { nameKey } from "../domain/names";
import {
  privateDirectory,
  replacePrivateFile,
  syncDirectory,
} from "../providers/private-files";
import type { OperatorEnvFiles } from "../runtime/contracts";

/** The operator env directories under `<root>/env`, one per Project name, as a rename carries them to the new name. Every
 * step can be run again after a crash: a move already made, or a copy already published, is recognised as done. */
export function createOperatorEnvFiles(root: string): OperatorEnvFiles {
  const envRoot = join(root, "env");
  const directory = (name: string) => join(envRoot, name);
  /** Where a copy is made before it is published under `to` by one rename; no Project name starts with a dot. */
  const staging = (to: string) => join(envRoot, `.renaming-${nameKey(to)}`);
  /** Where a published copy is withdrawn to, by one rename, before it is deleted. */
  const withdrawn = (to: string) => join(envRoot, `.removing-${nameKey(to)}`);
  /** ENV_SPLIT: the rename moved the env files to `to`, and a new directory was made under `from` since. Either way, the
   * other directory would be left with files nothing reads, so Rig refuses to choose. */
  const split = (from: string, to: string) =>
    new RigError(
      "ENV_SPLIT",
      `${directory(to)} holds this Project's env files, moved there by its unfinished rename, and ${directory(from)} was made since, so Rig will not choose between them.`,
      `Move what you need from ${directory(from)} into ${directory(to)}, then move ${directory(from)} aside, and run the rename again to finish or undo it.`,
      { path: directory(from), moved: directory(to) },
    );
  /** ENV_DIRECTORY_TAKEN unless `to` has no directory of its own: none at all, or `from`'s under a spelling that differs only in
   * case on a disk that ignores case. */
  const assertFree = async (from: string, to: string) => {
    const [source, destination] = [
      await entry(directory(from)),
      await entry(directory(to)),
    ];
    if (destination && !(source && sameEntry(source, destination)))
      throw new RigError(
        "ENV_DIRECTORY_TAKEN",
        `Operator env files for '${to}' already exist at ${directory(to)}, and they are not this Project's.`,
        `Nothing was renamed. Move ${directory(to)} aside (it may be left from a forgotten Project), then retry.`,
        { path: directory(to) },
      );
    return source;
  };
  const failed = (from: string, to: string, error: unknown) =>
    error instanceof RigError
      ? error
      : new RigError(
          "ENV_MOVE",
          `The operator env files at ${directory(from)} could not be given the name '${to}': ${failureReason(error)}`,
          `Check that ${envRoot} is writable by this user, then run the rename again.`,
          { path: directory(from) },
        );
  return {
    async plan({ from, to, sharedWith }) {
      if (from === to) return "none";
      const source = await assertFree(from, to);
      if (!source) return "none";
      for (const name of sharedWith) {
        const other = await entry(directory(name));
        if (other && sameEntry(other, source)) return "copy";
      }
      return "move";
    },
    async carry({ from, to, how }) {
      if (how === "none") {
        if (from !== to) await assertFree(from, to);
        return;
      }
      try {
        if (how === "copy") {
          // The destination was free when the rename began, and its name is reserved since: one there now is this
          // rename's published copy.
          if (await entry(directory(to))) return;
          // What an earlier attempt left aside: a copy cut short, or one an undo withdrew and did not finish deleting.
          await rm(withdrawn(to), { recursive: true, force: true });
          await rm(staging(to), { recursive: true, force: true });
          await copyTree(root, directory(from), staging(to));
          await rename(staging(to), directory(to));
          await syncDirectory(envRoot);
          return;
        }
        const source = await entry(directory(from));
        if (!source) return; // Moved by an earlier attempt, or there was nothing to move.
        // The destination was free when the rename began, and its name is reserved since: one there now holds the files
        // an earlier attempt moved, and the source is a directory made after it.
        const moved = await entry(directory(to));
        if (moved && !sameEntry(moved, source)) throw split(from, to);
        await rename(directory(from), directory(to));
        await syncDirectory(envRoot);
      } catch (error) {
        throw failed(from, to, error);
      }
    },
    async undo({ from, to, how }) {
      if (how === "copy") {
        await rm(staging(to), { recursive: true, force: true });
        // Withdrawn whole first, so the copy is either published complete or gone, however far its deletion gets.
        if (await entry(directory(to))) {
          await rm(withdrawn(to), { recursive: true, force: true });
          await rename(directory(to), withdrawn(to));
          await syncDirectory(envRoot);
        }
        await rm(withdrawn(to), { recursive: true, force: true });
      } else if (how === "move") {
        const moved = await entry(directory(to));
        if (!moved) return; // Never moved, or moved back by an earlier attempt.
        const original = await entry(directory(from));
        if (original && !sameEntry(original, moved)) throw split(from, to);
        await rename(directory(to), directory(from));
        await syncDirectory(envRoot);
      }
    },
  };
}
/** Copies the directory tree at `from` to a new `to`: directories 0700, each file with its own mode, flushed. Anything but
 * a regular file or a directory is refused before anything is written. */
async function copyTree(root: string, from: string, to: string) {
  const files: { path: string; mode: number }[] = [];
  const visit = async (relative: string) => {
    for (const item of await readdir(join(from, relative), {
      withFileTypes: true,
    })) {
      const path = join(relative, item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.isFile())
        files.push({
          path,
          mode: (await lstat(join(from, path))).mode & 0o777,
        });
      else
        throw new RigError(
          "ENV_SCOPE_SYMLINK",
          `${join(from, path)} is not a regular file or directory, so the operator env files cannot be copied.`,
          "Replace it with the real file, then run the rename again.",
          { path: join(from, path) },
        );
    }
  };
  await visit("");
  await privateDirectory(root, to);
  for (const file of files)
    await replacePrivateFile(
      root,
      join(to, file.path),
      await readFile(join(from, file.path)),
      { mode: file.mode, durable: true },
    );
}
/** The entry at `path` itself, never a link's target; undefined when there is none. */
async function entry(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function sameEntry(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
