import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RigError, errorMessage } from "../domain/errors";
import type { DeploymentFiles } from "../helpers/convex-contracts";

/** The local filesystem as a deployment's files. A private file is written beside itself and renamed into place, so a
 * reader never sees half of it. Every failure is CONVEX_FILES, naming the path and what was being done to it. */
export function createDeploymentFiles(): DeploymentFiles {
  const files: DeploymentFiles = {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },
    async writePrivate(target, text) {
      // A symlinked file (a shared .env.local) is written where it points, and stays a link.
      const path = await realpath(target).catch(() => target);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const staged = join(
        dirname(path),
        `.${basename(path)}.${process.pid}.tmp`,
      );
      await writeFile(staged, text, { mode: 0o600 });
      // A file that existed keeps its old mode through writeFile; the staged copy is new, so its mode is 600.
      await chmod(staged, 0o600);
      await rename(staged, path);
    },
    async vacant(path) {
      try {
        return (await readdir(path)).length === 0;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
    },
    async copyDirectory(from, to) {
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      // A staging directory of its own, which an interrupted copy leaves behind instead of a partial `to`.
      const staging = await mkdtemp(`${to}.rig-copy-`);
      try {
        await cp(from, join(staging, "tree"), {
          recursive: true,
          // A linked file is copied as the file it names, so the copy does not depend on where the link pointed.
          dereference: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        });
        // The copy keeps the source's modes; the deployment directory itself is private to its owner.
        await chmod(join(staging, "tree"), 0o700);
        // rename replaces an empty directory and refuses one with entries.
        await rename(join(staging, "tree"), to);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    async ensureDirectory(path) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
  };
  return {
    read: (path) => tagged("read", path, () => files.read(path)),
    writePrivate: (path, text) =>
      tagged("write", path, () => files.writePrivate(path, text)),
    vacant: (path) => tagged("list", path, () => files.vacant(path)),
    copyDirectory: (from, to) =>
      tagged(`copy ${from} to`, to, () => files.copyDirectory(from, to)),
    ensureDirectory: (path) =>
      tagged("create", path, () => files.ensureDirectory(path)),
  };
}
async function tagged<T>(
  action: string,
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new RigError(
      "CONVEX_FILES",
      `rigd convex could not ${action} ${path} (${errorMessage(error)}).`,
      "Check that the path is a directory or file your account owns and can write, on a volume with space, then start the Service again.",
      { path },
    );
  }
}
