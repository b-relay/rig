import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { runRigdCli } from "./cli/rigd";
import {
  daemonCommand,
  resolveToolBun,
  reportRootFailure,
  rigRoot,
  verifyRigRoot,
  userOutput,
} from "./cli/entry-environment";
import { createHostDiagnosticLog } from "./diagnostics/host-log";
import { DaemonAdmin } from "./daemon/admin";
import { composeDaemon } from "./daemon/composition";
import { readInstallationRecord } from "./daemon/installation";
import { runDaemonHost } from "./daemon/host";
import { securePrivateRoot } from "./daemon/private-root";
import { writeStartupFailure } from "./daemon/startup-failure";
import { runCapturedProcess } from "./providers/captured-process";
import { runCommand } from "./providers/command-runner";
import { createProxyInstallation } from "./daemon/proxy-installation";
import { readHostConfig } from "./config";
import { dashboardServing } from "./daemon/dashboard";
import {
  RELEASES,
  installEnvironment,
  installationGap,
  installedRelease,
  upgrade,
} from "./daemon/upgrade";
export async function main(args: readonly string[]): Promise<number> {
  let root: string;
  try {
    root = rigRoot();
    await verifyRigRoot(root);
  } catch (error) {
    return reportRootFailure(error, userOutput());
  }
  // The child supervisor's own invocation skips the command line parser and daemon setup below; a person
  // typing rigd capture (--help, no file) gets the documented command instead.
  if (args[0] === "capture" && args.length === 2 && !args[1]!.startsWith("-")) {
    try {
      return await runCapturedProcess(args[1]!);
    } catch (error) {
      return reportRootFailure(error, userOutput());
    }
  }
  if (process.env.RIG_DAEMON_CHILD === "1") {
    const command = await daemonCommand();
    let runtime;
    try {
      await securePrivateRoot(root);
      // The installing shell chose bun; the daemon never looks it up itself.
      const installation = await readInstallationRecord(root);
      runtime = await composeDaemon(
        root,
        [...command, "capture"],
        installation?.bun,
        // launchd's system job says so itself: its record may still name the LaunchAgent it replaces.
        process.env.RIG_DAEMON_MODE === "system"
          ? "system"
          : installation?.mode,
      );
    } catch (error) {
      // runDaemonHost records its own failures; composition failures need the same record.
      await writeStartupFailure(root, error);
      throw error;
    }
    await runDaemonHost({ root, port: 0, ...runtime });
    return 0;
  }
  const mode = process.env.RIG_ROOT ? "process" : "launchd";
  const admin = new DaemonAdmin({
    root,
    command: await daemonCommand(),
    bun: await resolveToolBun({
      execPath: process.execPath,
      entrypoint: process.argv[1],
      PATH: process.env.PATH,
    }),
    mode,
    userHome: homedir(),
    // The release installer passes its installation lock down on this descriptor (see scripts/install).
    ...(/^\d+$/.test(process.env.RIG_INSTALL_LOCK_FD ?? "")
      ? { inheritedLock: Number(process.env.RIG_INSTALL_LOCK_FD) }
      : {}),
    start: async () => (await readHostConfig(root)).daemon.start,
    dashboard: async () => dashboardServing(root, await readHostConfig(root)),
    proxy: createProxyInstallation({
      root,
      userHome: homedir(),
      uid: process.getuid?.() ?? 501,
      userName: userInfo().username,
      mode,
      run: runCommand,
    }),
  });
  return await runRigdCli(args, {
    admin,
    output: userOutput(),
    newOperationId: randomUUID,
    capture: runCapturedProcess,
    upgrade: (request) =>
      upgrade(
        {
          releases: process.env.RIG_RELEASE_URL || RELEASES,
          fetch: (url) => fetch(url, { redirect: "manual" }),
          installedRelease: () => installedRelease(join(root, "bin", "rigd")),
          missing: (release) =>
            installationGap(root, release, () => admin.status()),
          install: async (script, env) =>
            // Its output is the upgrade's progress, shown as it runs.
            Bun.spawn(["/bin/sh", script], {
              env: { ...installEnvironment(process.env, root), ...env },
              stdio: ["inherit", "inherit", "inherit"],
            }).exited,
        },
        request,
      ),
    diagnostics: createHostDiagnosticLog({
      root,
      source: "rigd",
      now: () => new Date(),
    }),
  });
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
