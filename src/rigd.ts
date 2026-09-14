import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { runRigdCli } from "./cli/rigd";
import {
  daemonCommand,
  reportRootFailure,
  rigRoot,
  userOutput,
} from "./cli/entry-environment";
import { createHostDiagnosticLog } from "./diagnostics/host-log";
import { DaemonAdmin } from "./daemon/admin";
import { composeDaemon } from "./daemon/composition";
import { runDaemonHost } from "./daemon/host";
import { writeStartupFailure } from "./daemon/startup-failure";
import { runCapturedProcess } from "./providers/captured-process";
export async function main(args: readonly string[]): Promise<number> {
  let root: string;
  try {
    root = rigRoot();
  } catch (error) {
    return reportRootFailure(error, userOutput());
  }
  if (args[0] === "capture") {
    // A private entrypoint, but its failures are still read by a person in the launchd log.
    const output = userOutput();
    if (!args[1] || args.length !== 2) {
      output.error("Usage: rigd capture <request-file>\n");
      return 2;
    }
    try {
      return await runCapturedProcess(args[1]);
    } catch (error) {
      return reportRootFailure(error, output);
    }
  }
  if (process.env.RIG_DAEMON_CHILD === "1") {
    const command = await daemonCommand();
    let runtime;
    try {
      runtime = await composeDaemon(root, [...command, "capture"]);
    } catch (error) {
      // runDaemonHost records its own failures; composition failures need the same record.
      await writeStartupFailure(root, error);
      throw error;
    }
    await runDaemonHost({ root, port: 0, ...runtime });
    return 0;
  }
  return await runRigdCli(args, {
    admin: new DaemonAdmin({
      root,
      command: await daemonCommand(),
      mode: process.env.RIG_ROOT ? "process" : "launchd",
      userHome: homedir(),
    }),
    output: userOutput(),
    newOperationId: randomUUID,
    diagnostics: createHostDiagnosticLog({
      root,
      source: "rigd",
      now: () => new Date(),
    }),
  });
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
