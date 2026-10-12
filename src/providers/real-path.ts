import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Where `path` really is: every symlink resolved. A path that does not exist yet resolves through its nearest existing
 * parent, so a file about to be created is placed where its directory really is. */
export async function realPath(path: string): Promise<string> {
  const absolute = resolve(path);
  return await realpath(absolute).catch(async () =>
    dirname(absolute) === absolute
      ? absolute
      : join(await realPath(dirname(absolute)), basename(absolute)),
  );
}
