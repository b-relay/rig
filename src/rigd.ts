import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { runRigdCli } from "./cli/rigd";
import { daemonCommand, rigRoot, userOutput } from "./cli/entry-environment";
import { createHostDiagnosticLog } from "./diagnostics/host-log";
import { DaemonAdmin } from "./daemon/admin";
import { composeDaemon } from "./daemon/composition";
import { runDaemonHost } from "./daemon/host";
import { runCapturedProcess } from "./providers/captured-process";
export async function main(args: readonly string[]): Promise<number> {
  const root = rigRoot();
  if (args[0] === "capture") {
    if (!args[1] || args.length !== 2) return 2;
    return await runCapturedProcess(args[1]);
  }
  if (process.env.RIG_DAEMON_CHILD === "1") {
    const command = daemonCommand();
    const runtime = await composeDaemon(root, [...command, "capture"]);
    await runDaemonHost({ root, port: 0, ...runtime });
    return 0;
  }
  return await runRigdCli(args, {
    admin: new DaemonAdmin({
      root,
      command: daemonCommand(),
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
