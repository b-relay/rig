import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RigError } from "../domain/errors";

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

/** Undefined when rigd was never installed under this root; a record that cannot be read or parsed is a DAEMON_INSTALL_STATE error. */
export async function readInstallationRecord(
  root: string,
): Promise<InstallationRecord | undefined> {
  let saved: unknown;
  try {
    saved = JSON.parse(await readFile(installationPath(root), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RigError(
      "DAEMON_INSTALL_STATE",
      "The installation record is unreadable.",
      `Inspect ${installationPath(root)}; with no rigd running, rigd install rewrites it.`,
      { path: installationPath(root) },
    );
  }
  const installation = installationSchema.safeParse(saved);
  if (!installation.success)
    throw new RigError(
      "DAEMON_INSTALL_STATE",
      "The installation record is invalid.",
      `Inspect ${installationPath(root)}; with no rigd running, rigd install rewrites it.`,
      { path: installationPath(root) },
    );
  return installation.data;
}
