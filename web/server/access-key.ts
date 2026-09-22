import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/** The key in `file`, created on first start. It is never logged; read it with `cat`. */
export async function accessKey(file: string): Promise<string> {
  const existing = await readFile(file, "utf8").catch(() => "");
  if (existing.trim().length >= 32) {
    // A key someone placed here by hand may be readable by others; it never should be.
    await chmod(file, 0o600);
    return existing.trim();
  }
  const key = randomBytes(32).toString("base64url");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return key;
}
