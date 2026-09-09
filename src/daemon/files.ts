import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RigError } from "../domain/errors";

export const ownerSchema = z.object({
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
});
export const addressSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  instanceId: z.string().min(1),
});

/** Filesystem adapter: absence is distinct from unreadable or corrupt ownership evidence. */
async function readRecord<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RigError(
      "DAEMON_STATE",
      "Cannot read daemon ownership evidence.",
      "Inspect daemon state before retrying.",
    );
  }
  const parsed = schema.safeParse(
    (() => {
      try {
        return JSON.parse(contents);
      } catch {
        return undefined;
      }
    })(),
  );
  if (!parsed.success)
    throw new RigError(
      "DAEMON_STATE",
      "Daemon ownership evidence is invalid.",
      "Inspect daemon state before retrying; preserve the existing files.",
    );
  return parsed.data;
}

export function readDaemonAddress(root: string) {
  return readRecord(join(root, "daemon", "address.json"), addressSchema);
}
export function readDaemonOwner(root: string) {
  return readRecord(join(root, "daemon", "owner.json"), ownerSchema);
}

export async function readDaemonToken(root: string): Promise<string> {
  try {
    const value = (
      await readFile(join(root, "auth", "control-plane.token"), "utf8")
    ).trim();
    if (!value) throw new Error("Empty token");
    return value;
  } catch {
    throw new RigError(
      "DAEMON_MISSING",
      "rigd is not installed.",
      "Run 'rigd install' to set up the daemon.",
    );
  }
}
