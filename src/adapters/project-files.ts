import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
/** Refuses a path whose file, or nearest existing directory when there is no file, is outside the Project directory
 * once symbolic links are followed: a `scripts` linked elsewhere holds files the Project's commits never carry. */
async function refuseLinkOut(
  directory: string,
  absolute: string,
  path: string,
): Promise<void> {
  let parent = absolute;
  while (!(await present(parent)) && dirname(parent) !== parent)
    parent = dirname(parent);
  const [real, project] = await Promise.all([
    realpath(parent),
    realpath(directory),
  ]);
  const inside = relative(project, real);
  if (inside.startsWith("..") || isAbsolute(inside))
    throw new RigError(
      "RECIPE_FILE_PATH",
      `The recipe file ${path} is outside the Project directory ${directory}: ${parent} leads to ${real}.`,
      `Replace the link at ${parent} with a file or directory of the Project itself, so its checkout carries it.`,
      { path },
    );
}
async function present(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
