import { waitForLogPoll } from "./adapters/log-follow-scheduler";
import { createTerminalInteraction } from "./adapters/terminal-interaction";
import { randomUUID } from "node:crypto";
import { runRigCli } from "./cli/rig";
import {
  interruptLadder,
  reportRootFailure,
  rigRoot,
  userOutput,
} from "./cli/entry-environment";
import { createHostDiagnosticLog } from "./diagnostics/host-log";
import { connectDaemon, isDaemonUnavailable } from "./daemon/connection";
import type { CliDependencies } from "./cli/types";
import { inspectOfflineHost } from "./daemon/offline-doctor";
export async function main(args: readonly string[]): Promise<number> {
  const interrupts = interruptLadder((code) => process.exit(code));
  // A reader that has gone away ends the command the way Ctrl-C does; rigd keeps running whatever it was asked.
  const output = userOutput(interrupts.interrupt);
  let root: string;
  try {
    root = rigRoot();
  } catch (error) {
    return reportRootFailure(error, output);
  }
  const cwd = process.cwd();
  process.on("SIGINT", interrupts.interrupt);
  process.on("SIGTERM", interrupts.interrupt);
  try {
    return await runRigCli(args, {
      root,
      cwd,
      output,
      newOperationId: randomUUID,
      diagnostics: createHostDiagnosticLog({
        root,
        source: "rig",
        now: () => new Date(),
      }),
      signal: interrupts.cancel,
      detach: interrupts.detach,
      wait: waitForLogPoll,
      ...(process.stdin.isTTY && process.stderr.isTTY
        ? {
            interaction: createTerminalInteraction(
              process.stdin,
              process.stderr,
              { signal: interrupts.cancel, interrupt: interrupts.interrupt },
            ),
          }
        : {}),
      client: createCliClient(root, cwd),
    });
  } finally {
    process.removeListener("SIGINT", interrupts.interrupt);
    process.removeListener("SIGTERM", interrupts.interrupt);
  }
}
/** CLI policy: only Doctor continues with read-only Host inspection when unavailable. */
export function createCliClient(
  root: string,
  cwd: string,
): CliDependencies["client"] {
  return {
    async status(selection) {
      return (await connectDaemon(root)).status(selection);
    },
    async command(request, signal) {
      try {
        return await (await connectDaemon(root)).command(request, signal);
      } catch (error) {
        if (request.action === "doctor" && isDaemonUnavailable(error))
          return inspectOfflineHost(root, request.repoPath ?? cwd);
        throw error;
      }
    },
  };
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
