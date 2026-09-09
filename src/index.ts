import { createTerminalInteraction } from "./adapters/terminal-interaction";
import { randomUUID } from "node:crypto";
import { runRigCli } from "./cli/rig";
import { rigRoot, userOutput } from "./cli/entry-environment";
import { createHostDiagnosticLog } from "./diagnostics/host-log";
import { DaemonClient } from "./daemon/client";
import { readDaemonAddress, readDaemonToken } from "./daemon/files";
import { inspectOfflineHost } from "./daemon/offline-doctor";
import { RigError } from "./domain/errors";
export async function main(args: readonly string[]): Promise<number> {
  const root = rigRoot();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    return await runRigCli(args, {
      root,
      cwd: process.cwd(),
      output: userOutput(),
      newOperationId: randomUUID,
      diagnostics: createHostDiagnosticLog({
        root,
        source: "rig",
        now: () => new Date(),
      }),
      signal: controller.signal,
      ...(process.stdin.isTTY && process.stderr.isTTY
        ? {
            interaction: createTerminalInteraction(
              process.stdin,
              process.stderr,
              controller.signal,
            ),
          }
        : {}),
      client: {
        async command(request) {
          const address = await readDaemonAddress(root);
          if (!address && request.action === "doctor")
            return await inspectOfflineHost(
              root,
              request.repoPath ?? process.cwd(),
            );
          if (!address)
            throw new RigError(
              "DAEMON_MISSING",
              "rigd is not installed or reachable.",
              "Run rigd install to start the daemon.",
            );
          try {
            return await new DaemonClient({
              port: address.port,
              token: await readDaemonToken(root),
            }).command(request);
          } catch (error) {
            if (
              request.action === "doctor" &&
              error instanceof RigError &&
              ["DAEMON_UNREACHABLE", "DAEMON_MISSING"].includes(error.code)
            )
              return await inspectOfflineHost(
                root,
                request.repoPath ?? process.cwd(),
              );
            throw error;
          }
        },
      },
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
