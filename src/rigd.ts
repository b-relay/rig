import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
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
import { writeStartupFailure } from "./daemon/startup-failure";
import { runCapturedProcess } from "./providers/captured-process";
import { runCommand } from "./providers/command-runner";
import { createProxyInstallation } from "./daemon/proxy-installation";
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
      // The installing shell chose bun; the daemon never looks it up itself.
      const installation = await readInstallationRecord(root);
      runtime = await composeDaemon(
        root,
        [...command, "capture"],
        installation?.bun,
        installation?.mode,
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
  return await runRigdCli(args, {
    admin: new DaemonAdmin({
      root,
      command: await daemonCommand(),
      bun: await resolveToolBun({
        execPath: process.execPath,
        entrypoint: process.argv[1],
        PATH: process.env.PATH,
      }),
      mode,
      userHome: homedir(),
      proxy: createProxyInstallation({
        root,
        userHome: homedir(),
        uid: process.getuid?.() ?? 501,
        mode,
        run: runCommand,
      }),
    }),
    output: userOutput(),
    newOperationId: randomUUID,
    capture: runCapturedProcess,
    diagnostics: createHostDiagnosticLog({
      root,
      source: "rigd",
      now: () => new Date(),
    }),
  });
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
