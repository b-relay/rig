import { chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { within } from "../../src/domain/paths";
import {
  readPrivateFile,
  replacePrivateFile,
} from "../../src/providers/private-files";

/** The key in `file`, created on first start. It is never logged; read it with `cat`. A key is taken only from a regular
 * file the user owns that no one else can write, never through a link, and is written as a new private file renamed into
 * place; anything else at `file` is refused rather than trusted or written through. A file under the Rig root `root` is
 * checked from the root down; one elsewhere (a public site's own data directory) from its own directory. */
export async function accessKey(file: string, root: string): Promise<string> {
  const anchor = within(resolve(root), resolve(file)) ? root : dirname(file);
  const existing = await readPrivateFile(anchor, file).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  if (existing.trim().length >= 32) {
    // A key placed here by hand may be readable by others; it never should be. It is a regular file, checked above.
    await chmod(file, 0o600);
    return existing.trim();
  }
  const key = randomBytes(32).toString("base64url");
  await replacePrivateFile(anchor, file, `${key}\n`);
  return key;
}
