import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RigError } from "../domain/errors";
import { environmentText } from "../domain/service-definition";

/** `<RIG_ROOT>/auth/environment-digest.key`: the random key rigd takes environment digests with, readable by the user only. */
export function environmentKeyPath(root: string): string {
  return join(root, "auth", "environment-digest.key");
}

/** The keyed digest of one composed environment, the checkout path `checkout` normalized. */
export type EnvironmentDigest = (
  env: Readonly<Record<string, string>>,
  checkout: string,
) => Promise<string>;

/** Digests of composed environments as HMAC-SHA256 under a random key kept 0600 at `environmentKeyPath(root)`, created on
 * first use (ADR 0016). The key keeps a guessable value from being brute-forced out of a digest in state.json; a digest
 * says only whether two environments are equal. The key is read once and kept; one that cannot be read or written fails
 * ENV_DIGEST, and is tried again by the next digest. */
export function createEnvironmentDigest(root: string): EnvironmentDigest {
  let key: Promise<Buffer> | undefined;
  return async (env, checkout) => {
    key ??= loadKey(environmentKeyPath(root)).catch((error: unknown) => {
      key = undefined;
      throw error;
    });
    return createHmac("sha256", await key)
      .update(environmentText(env, checkout))
      .digest("hex");
  };
}
/** The key at `path`, created when there is none; two rigd operations creating it at once agree on the one written first. */
async function loadKey(path: string): Promise<Buffer> {
  try {
    return parseKey(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw keyFailure(path, error);
  }
  try {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, randomBytes(32).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw keyFailure(path, error);
  }
  try {
    return parseKey(await readFile(path, "utf8"), path);
  } catch (error) {
    throw keyFailure(path, error);
  }
}
function parseKey(text: string, path: string): Buffer {
  const key = Buffer.from(text.trim(), "base64url");
  if (key.length < 16)
    throw new RigError(
      "ENV_DIGEST",
      `The environment digest key at ${path} is not a key Rig wrote.`,
      `Delete ${path}; rigd writes a new one, and the next deploy restarts every Service once.`,
      { path },
    );
  return key;
}
function keyFailure(path: string, error: unknown): RigError {
  if (error instanceof RigError) return error;
  const cause = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
  return new RigError(
    "ENV_DIGEST",
    `The environment digest key at ${path} cannot be read or written (${cause}).`,
    `Make ${path} and its directory readable and writable by you; until then a deploy restarts every Service.`,
    { path, cause },
  );
}
