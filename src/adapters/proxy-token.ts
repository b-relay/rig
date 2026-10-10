import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeToken, proxyPaths } from "../domain/managed-proxy";

/** Stores the DNS provider token `rig proxy token` was given: trimmed and checked first, then written whole with mode 0600
 * by renaming a new file into place, so Caddy never reads half a token. Returns the path; never the token. */
export async function writeProxyToken(
  root: string,
  input: string,
): Promise<string> {
  const token = normalizeToken(input);
  const path = proxyPaths(root).token;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, token, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}
/** Whether the stored token can be used, judged without revealing any of it. */
export type ProxyTokenState =
  | { readonly state: "ok" }
  | { readonly state: "missing" }
  | { readonly state: "unreadable" }
  | { readonly state: "malformed" }
  | { readonly state: "exposed"; readonly mode: number }
  | { readonly state: "foreign"; readonly uid: number };
export async function inspectProxyToken(
  root: string,
  uid = process.getuid?.(),
): Promise<ProxyTokenState> {
  const path = proxyPaths(root).token;
  const info = await stat(path).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : null,
  );
  if (info === undefined) return { state: "missing" };
  if (info === null) return { state: "unreadable" };
  if (uid !== undefined && info.uid !== uid)
    return { state: "foreign", uid: info.uid };
  if ((info.mode & 0o077) !== 0)
    return { state: "exposed", mode: info.mode & 0o777 };
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return { state: "unreadable" };
  try {
    // A stored token must already be in the form rig proxy token writes.
    return normalizeToken(text) === text
      ? { state: "ok" }
      : { state: "malformed" };
  } catch {
    return { state: "malformed" };
  }
}
