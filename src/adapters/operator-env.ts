import type { Stats } from "node:fs";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { RigError, failureReason } from "../domain/errors";
import { replacePrivateFile, syncDirectory } from "../providers/private-files";
import type { OperatorEnvFiles } from "../runtime/contracts";

/** The operator env directories under `<root>/env`, one per Project name, as a rename carries them to the new name. */
export function createOperatorEnvFiles(root: string): OperatorEnvFiles {
  const envRoot = join(root, "env");
  const directory = (name: string) => join(envRoot, name);
  return {
    async carry({ from, to, sharedWith }) {
      let source: { name: string; info: Stats } | undefined;
      for (const name of from) {
        const info = await entry(directory(name));
        if (info) {
          source = { name, info };
          break;
        }
      }
      if (!source || source.name === to) return { kind: "none" };
      const destination = await entry(directory(to));
      // The same directory under a spelling that differs only in case, on a disk that ignores case: renamed in place.
      if (destination && !sameEntry(destination, source.info))
        throw new RigError(
          "ENV_CONFLICT",
          `The operator env files of '${to}' already exist at ${directory(to)}, so the env files at ${directory(source.name)} cannot be given that name.`,
          `Nothing was renamed. Move ${directory(to)} aside (it may be left from a forgotten Project, or from a rename that was interrupted), then retry.`,
          { path: directory(to), from: directory(source.name) },
        );
      const shared = await sharedName(source.info, sharedWith);
      try {
        if (shared === undefined) {
          await rename(directory(source.name), directory(to));
          await syncDirectory(envRoot);
          return { kind: "moved", from: source.name, to };
        }
        await copyTree(root, directory(source.name), directory(to));
        return { kind: "copied", from: source.name, to, sharedWith: shared };
      } catch (error) {
        if (shared !== undefined)
          await rm(directory(to), { recursive: true, force: true }).catch(
            () => {},
          );
        if (error instanceof RigError) throw error;
        throw new RigError(
          "ENV_MOVE",
          `The operator env files at ${directory(source.name)} could not be given the name '${to}': ${failureReason(error)}`,
          `Nothing was renamed. Check that ${envRoot} is writable by this user, then retry.`,
          { path: directory(source.name) },
        );
      }
    },
    async undo(carry) {
      if (carry.kind === "moved") {
        await rename(directory(carry.to), directory(carry.from));
        await syncDirectory(envRoot);
      } else if (carry.kind === "copied")
        await rm(directory(carry.to), { recursive: true, force: true });
    },
  };
  /** The first of `names` whose env directory is `info`'s own: another Project's name that differs only in case reaches
   * it on a disk that ignores case. */
  async function sharedName(info: Stats, names: readonly string[]) {
    for (const name of names) {
      const other = await entry(directory(name));
      if (other && sameEntry(other, info)) return name;
    }
    return undefined;
  }
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
          "Nothing was renamed. Replace it with the real file, then retry.",
          { path: join(from, path) },
        );
    }
  };
  await visit("");
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
