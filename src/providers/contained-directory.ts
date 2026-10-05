import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { RigError } from "../domain/errors";

/** Fails WORKING_DIR_OUTSIDE when `directory`, with every symlink resolved, is not `root` or inside it: a working_dir that
 * is a symlink out of the workspace passes the config's path rules but would run there. A directory that is not there
 * passes, so the caller reports it as missing. It guards against mistakes, not against the command, which may cd anywhere. */
export async function assertContainedDirectory(
  directory: string,
  root: string,
): Promise<void> {
  const real = await realpath(directory).catch(() => undefined);
  if (real === undefined) return;
  const realRoot = await realpath(root).catch(() => root);
  if (real === realRoot || real.startsWith(realRoot + sep)) return;
  throw new RigError(
    "WORKING_DIR_OUTSIDE",
    `The working directory ${directory} resolves to ${real}, outside the workspace ${realRoot}.`,
    "Point working_dir at a directory inside the repository, not a symlink that leads out of it.",
    { directory, resolved: real, workspace: realRoot },
  );
}
