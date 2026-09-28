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
import type { DeploymentFiles } from "../helpers/convex-contracts";

/** The local filesystem as a deployment's files. A private file is written beside itself and renamed into place, so a
 * reader never sees half of it. */
export function createDeploymentFiles(): DeploymentFiles {
  return {
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
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        });
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
}
