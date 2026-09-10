import { waitForLogPoll } from "./adapters/log-follow-scheduler";
import { createTerminalInteraction } from "./adapters/terminal-interaction";
import { randomUUID } from "node:crypto";
import { runRigCli } from "./cli/rig";
import { rigRoot, userOutput } from "./cli/entry-environment";
import { createHostDiagnosticLog } from "./diagnostics/host-log";
import { connectDaemon, isDaemonUnavailable } from "./daemon/connection";
import type { CliDependencies } from "./cli/types";
import { inspectOfflineHost } from "./daemon/offline-doctor";
export async function main(args: readonly string[]): Promise<number> {
  const root = rigRoot();
  const cwd = process.cwd();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    return await runRigCli(args, {
      root,
      cwd,
      output: userOutput(),
      newOperationId: randomUUID,
      diagnostics: createHostDiagnosticLog({
        root,
        source: "rig",
        now: () => new Date(),
      }),
      signal: controller.signal,
      wait: waitForLogPoll,
      ...(process.stdin.isTTY && process.stderr.isTTY
        ? {
            interaction: createTerminalInteraction(
              process.stdin,
              process.stderr,
              controller.signal,
            ),
          }
        : {}),
      client: createCliClient(root, cwd),
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
/** CLI policy: only Doctor continues with read-only Host inspection when unavailable. */
export function createCliClient(root: string, cwd: string): CliDependencies["client"] {
  return {
    async status(selection) {
      return (await connectDaemon(root)).status(selection);
    },
    async command(request) {
      try {
        return await (await connectDaemon(root)).command(request);
      } catch (error) {
        if (request.action === "doctor" && isDaemonUnavailable(error))
          return inspectOfflineHost(root, request.repoPath ?? cwd);
        throw error;
      }
    },
  };
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
