import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RigError, errorMessage } from "../domain/errors";
/** What the daemon reports about its own failed start, for the installer that cannot see its stderr. */
export interface StartupFailure {
  code: string;
  message: string;
  hint?: string;
  at: string;
}
const failureSchema = z.object({
  code: z.string().describe("RigError code, or UNEXPECTED."),
  message: z.string().describe("What failed."),
  hint: z.string().optional().describe("What to do about it."),
  at: z.string().describe("ISO time the failure was recorded."),
});
const path = (root: string) => join(root, "daemon", "startup-failure.json");
/** Records why this start failed; its own failure must not mask the cause. */
export async function writeStartupFailure(
  root: string,
  error: unknown,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  const failure: StartupFailure = {
    code: error instanceof RigError ? error.code : "UNEXPECTED",
    message: errorMessage(error),
    ...(error instanceof RigError ? { hint: error.hint } : {}),
    at: now(),
  };
  await writeFile(path(root), JSON.stringify(failure), { mode: 0o600 }).catch(
    () => {},
  );
}
/** The last recorded startup failure, or undefined when none or unreadable. */
export async function readStartupFailure(
  root: string,
): Promise<StartupFailure | undefined> {
  try {
    return failureSchema.parse(JSON.parse(await readFile(path(root), "utf8")));
  } catch {
    return undefined;
  }
}
export async function clearStartupFailure(root: string): Promise<void> {
  await rm(path(root), { force: true });
}
