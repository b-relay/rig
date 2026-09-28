import {
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
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
    async writePrivate(path, text) {
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
    async copyDirectory(from, to) {
      await cp(from, to, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    },
    async ensureDirectory(path) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
  };
}
