import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectFiles } from "../cli/types";
import { RigError, errorMessage } from "../domain/errors";

/** `path` (relative, `/`-separated) under the Project directory `directory`, as an absolute path. Throws RECIPE_FILE_PATH
 * when it would leave the directory. */
export function projectFilePath(directory: string, path: string): string {
  const absolute = resolve(directory, path);
  const inside = relative(directory, absolute);
  if (isAbsolute(path) || !inside || inside.startsWith(".."))
    throw new RigError(
      "RECIPE_FILE_PATH",
      `The recipe file path '${path}' is not inside the Project directory ${directory}.`,
      "A recipe file path is relative to the directory holding rig.yaml.",
      { path },
    );
  return absolute;
}
/** The text of the Project's file at `path` under `directory`; undefined when there is no such file. Fails
 * RECIPE_FILE_PATH for a path outside the directory, symbolic links followed (a linked file or directory elsewhere is
 * not the Project's: its checkout does not carry it), and PROJECT_FILE_UNREADABLE for one that cannot be read. */
export async function readProjectFile(
  directory: string,
  path: string,
): Promise<string | undefined> {
  const absolute = projectFilePath(directory, path);
  await refuseLinkOut(directory, absolute, path);
  try {
    return await readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RigError(
      "PROJECT_FILE_UNREADABLE",
      `The Project file ${absolute} could not be read (${errorMessage(error)}).`,
      "Fix its permissions, or move it aside.",
      { path: absolute },
    );
  }
}
/** The local filesystem as the Project files `rig recipe generate` writes. */
export function createProjectFiles(): ProjectFiles {
  return {
    async projectDirectory(cwd) {
      for (let directory = resolve(cwd); ; directory = dirname(directory)) {
        if (await present(join(directory, "rig.yaml"))) return directory;
        // A repository's root is as far as a Project reaches.
        if (
          (await present(join(directory, ".git"))) ||
          dirname(directory) === directory
        )
          return resolve(cwd);
      }
    },
    read: readProjectFile,
    async create(directory, path, text) {
      const absolute = projectFilePath(directory, path);
      await refuseLinkOut(directory, absolute, path);
      try {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, text, { flag: "wx", mode: 0o644 });
      } catch (error) {
        throw new RigError(
          "RECIPE_FILE_WRITE",
          `The recipe file ${absolute} could not be written (${errorMessage(error)}).`,
          "Check that the Project directory is writable and the file is not there, then run rig recipe generate again.",
          { path: absolute },
        );
      }
    },
  };
}
/** Refuses a recipe file path any part of which, below the Project directory, is a symbolic link. A link out of the
 * Project holds files its commits never carry, and a link with an absolute target inside it still points at this one
 * checkout from every other: a recipe file is a plain file of the Project, at its path. */
async function refuseLinkOut(
  directory: string,
  absolute: string,
  path: string,
): Promise<void> {
  const parts = relative(directory, absolute).split(sep);
  for (let depth = 1; depth <= parts.length; depth++) {
    const part = join(directory, ...parts.slice(0, depth));
    const metadata = await lstat(part).catch(() => undefined);
    // Nothing further down exists yet: create makes plain directories and the file.
    if (!metadata) return;
    if (metadata.isSymbolicLink())
      throw new RigError(
        "RECIPE_FILE_PATH",
        `The recipe file ${path} is reached through the symbolic link ${part}, so a checkout of the Project does not carry it as its own.`,
        `Replace the link at ${part} with a file or directory of the Project itself.`,
        { path },
      );
  }
}
async function present(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
