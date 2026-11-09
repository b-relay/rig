import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RigError, errorMessage } from "../domain/errors";
import { describeInvalidDocument } from "../domain/invalid-document";

/** `<RIG_ROOT>/daemon/install.json`, written by `rigd install` and read by `rigd` itself at startup. */
export const installationSchema = z.object({
  mode: z
    .enum(["process", "launchd", "system"])
    .describe(
      "How rigd was started: a detached process (under RIG_ROOT), a launchd job in the user's login, or a system job that runs as the user from boot.",
    ),
  command: z
    .array(z.string())
    .optional()
    .describe("The program and arguments that start rigd."),
  version: z
    .string()
    .optional()
    .describe("The build stamp of the rigd that wrote this record."),
  bun: z
    .string()
    .optional()
    .describe(
      "The bun that Tools whose bin is a source file run with; absent when rigd install found none.",
    ),
  proxy: z
    .enum(["managed", "external"])
    .optional()
    .describe(
      "How the installed rigd publishes routes: through Rig's own Caddy (managed) or a route file another Caddy imports (external, also when absent).",
    ),
});
export type InstallationRecord = z.infer<typeof installationSchema>;
/** How rigd runs: a detached process, a LaunchAgent in the user's login, or a system job that runs as the user from boot. */
export type DaemonMode = InstallationRecord["mode"];

export function installationPath(root: string): string {
  return join(root, "daemon", "install.json");
}
/** `<RIG_ROOT>/daemon/install.lock`: held by `rigd install` and `rigd uninstall`, and by the release installer from
 * publishing a release to the end of the rigd install it runs, so one changes the Rig root at a time. */
export function installLockPath(root: string): string {
  return join(root, "daemon", "install.lock");
}

/** Undefined when rigd was never installed under this root; a record that cannot be read or parsed is a DAEMON_INSTALL_STATE
 * error whose hint names the file, what is wrong with it, and the repair, which works whether or not rigd still runs: an
 * install with no record adopts the rigd that serves, or starts one. */
export async function readInstallationRecord(
  root: string,
): Promise<InstallationRecord | undefined> {
  const path = installationPath(root);
  const refused = (message: string, problem: string) =>
    new RigError(
      "DAEMON_INSTALL_STATE",
      message,
      `${path} ${problem}. Delete it, then run rigd install, which records the rigd that is running, or starts one when none is.`,
      { path },
    );
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw refused(
      `The installation record ${path} is unreadable.`,
      `cannot be read (${errorMessage(error)})`,
    );
  }
  try {
    return installationSchema.parse(JSON.parse(text));
  } catch (error) {
    throw refused(
      `The installation record ${path} is invalid.`,
      describeInvalidDocument(error, "installation record"),
    );
  }
}
