import { chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
  readPrivateFile,
  replacePrivateFile,
} from "../../src/providers/private-files";

/** The key in `file`, created on first start. It is never logged; read it with `cat`. A key is taken only from a regular
 * file the user owns that no one else can write, never through a link; anything else there is refused rather than
 * trusted or written through. */
export async function accessKey(file: string): Promise<string> {
  const directory = dirname(file);
  const existing = await readPrivateFile(directory, file).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  if (existing.trim().length >= 32) {
    // A key someone placed here by hand may be readable by others; it never should be.
    await chmod(file, 0o600);
    return existing.trim();
  }
  const key = randomBytes(32).toString("base64url");
  await replacePrivateFile(directory, file, `${key}\n`);
  return key;
}
