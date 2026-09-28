#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { runRigdCli } from "./cli/rigd";
import {
  daemonCommand,
  rigdExecutable,
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
import { runConvexCli } from "./cli/convex-command";
import { runConvexProcess } from "./helpers/convex-process";
export async function main(args: readonly string[]): Promise<number> {
  // A Service helper runs as a Service's process, whose environment has no RIG_ROOT: it reads and writes no Rig state,
  // so it is dispatched before the root is resolved, and its failures go to stderr (the Target log), not a Rig log.
  if (args[0] === "convex") {
    const output = userOutput();
    return await runConvexCli(args, {
      output,
      run: (options) => runConvexProcess(options, output),
    });
  }
  let root: string;
  try {
    root = rigRoot();
    await verifyRigRoot(root);
  } catch (error) {
    return reportRootFailure(error, userOutput());
  }
  // launchd's own invocation skips the command line parser and daemon setup below; a person
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
        process.env.RIG_DAEMON_MODE === "process" ? "process" : "launchd",
        rigdExecutable(command),
      );
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
      bun: await resolveToolBun({
        execPath: process.execPath,
        entrypoint: process.argv[1],
        PATH: process.env.PATH,
      }),
      mode: process.env.RIG_ROOT ? "process" : "launchd",
      userHome: homedir(),
    }),
    output: userOutput(),
    newOperationId: randomUUID,
    capture: runCapturedProcess,
    convex: (options) => runConvexProcess(options, userOutput()),
    diagnostics: createHostDiagnosticLog({
      root,
      source: "rigd",
      now: () => new Date(),
    }),
  });
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
