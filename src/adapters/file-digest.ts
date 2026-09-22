import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { RigError } from "../domain/errors";
/** Answers a file's SHA-256, or undefined when there is no file at `path`. */
export type FileDigest = (path: string) => Promise<string | undefined>;
/** Reads and hashes the whole file. Compiled Tools are 64 MB each, so a status call that hashes
 * every one of them inside its shared budget is what flipped Tools to unknown. */
export const fileDigest: FileDigest = async (path) => {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile())
    throw new RigError(
      "ARTIFACT_TYPE",
      "An installation path is not a regular file.",
      "Preserve the existing path and choose another installation name.",
      { path },
    );
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
};
/** A digest that hashes a file once and answers from memory while the file's identity, size, and
 * change times stay the same. Installation publishes by atomic rename, which changes the
 * identity, so a replaced executable is always re-read. `hash` is the uncached digest. */
export function rememberedDigests(hash: FileDigest = fileDigest): FileDigest {
  const known = new Map<string, { fingerprint: string; digest: string }>();
  return async (path) => {
    const before = await fingerprint(path);
    if (before === undefined) {
      known.delete(path);
      return undefined;
    }
    const seen = known.get(path);
    if (seen?.fingerprint === before) return seen.digest;
    const digest = await hash(path);
    // A file rewritten while it was being read is hashed again next time rather than remembered.
    if (digest !== undefined && (await fingerprint(path)) === before)
      known.set(path, { fingerprint: before, digest });
    else known.delete(path);
    return digest;
  };
}
/** What identifies one file's content without reading it, or undefined when there is no file. */
async function fingerprint(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
