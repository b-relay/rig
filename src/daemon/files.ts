import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RigError } from "../domain/errors";

/** Start time as ps reports it; absent in records written by an older rigd, whose pid alone cannot be verified. */
const startedAt = z.string().min(1).optional();
export const ownerSchema = z.object({
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
  startedAt,
});
export const addressSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  instanceId: z.string().min(1),
  startedAt,
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

export function daemonTokenPath(root: string): string {
  return join(root, "auth", "control-plane.token");
}
/** Absence means no installation; an empty or unreadable credential is a defect in an existing one and is named by path. */
export async function readDaemonToken(root: string): Promise<string> {
  const path = daemonTokenPath(root);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const cause = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (cause === "ENOENT")
      throw new RigError(
        "DAEMON_MISSING",
        "rigd is not installed.",
        "Run 'rigd install' to set up the daemon.",
      );
    throw new RigError(
      "DAEMON_TOKEN",
      `The daemon credential at ${path} cannot be read (${cause}).`,
      `Make ${path} a file owned by you with mode 600. If no rigd is running for this root, 'rigd install' reissues it.`,
      { path, cause },
    );
  }
  const value = contents.trim();
  if (!value)
    throw new RigError(
      "DAEMON_TOKEN",
      `The daemon credential at ${path} is empty.`,
      `If no rigd is running for this root, 'rigd install' reissues it; otherwise stop the running rigd first.`,
      { path },
    );
  return value;
}
