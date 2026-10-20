import { waitForLogPoll } from "./adapters/log-follow-scheduler";
import { createTerminalInteraction } from "./adapters/terminal-interaction";
import { randomUUID } from "node:crypto";
import { reportStartupFailure, runRigCli } from "./cli/rig";
import {
  interruptLadder,
  rigRoot,
  userOutput,
  verifyRigRoot,
} from "./cli/entry-environment";
import { createHostDiagnosticLog } from "./diagnostics/host-log";
import { connectDaemon, isDaemonUnavailable } from "./daemon/connection";
import type { CliDependencies } from "./cli/types";
import type { DaemonClientOptions } from "./daemon/client";
import { inspectOfflineHost } from "./daemon/offline-doctor";
import { inspectHost } from "./adapters/host-inspection";
import { createProjectDocuments } from "./adapters/project-documents";
import { runCommand } from "./providers/command-runner";
import { inheritedEnvironment } from "./daemon/environment";
import { homedir } from "node:os";
import { writeProxyToken } from "./adapters/proxy-token";
import { verifyProxyCertificates } from "./adapters/proxy-verify";
import { readHostConfig } from "./config";
import { RigError } from "./domain/errors";
export async function main(args: readonly string[]): Promise<number> {
  const interrupts = interruptLadder((code) => process.exit(code));
  // A reader that has gone away ends the command the way Ctrl-C does; rigd keeps running whatever it was asked. A second
  // Ctrl-C also gives up on a reader that stopped taking the output.
  const output = userOutput({
    onClosed: interrupts.interrupt,
    abandon: interrupts.detach,
  });
  // rig exits once its reader took everything it printed. Output given up on makes the exit an interrupted one; output
  // that could not be written is a failure, said on stderr so nothing is added to what stdout already holds.
  const finished = async (code: number) => {
    const end = await output.flushed();
    if (end.failed) {
      await output.error(`${end.failed.message}\n${end.failed.hint}\n`);
      return 1;
    }
    return end.abandoned ? 130 : code;
  };
  const cwd = process.cwd();
  let root: string;
  try {
    root = rigRoot();
    await verifyRigRoot(root);
  } catch (error) {
    return finished(await reportStartupFailure(args, cwd, output, error));
  }
  process.on("SIGINT", interrupts.interrupt);
  process.on("SIGTERM", interrupts.interrupt);
  try {
    const code = await runRigCli(args, {
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
      now: () => new Date(),
      liveOutput: process.stderr.isTTY === true,
      ...(process.stdout.isTTY
        ? {
            outputTerminal: () => ({
              // A terminal that reports no size, or zero, is taken to be the classic 80 by 24.
              columns: process.stdout.columns || 80,
              rows: process.stdout.rows || 24,
            }),
          }
        : {}),
      ...(process.stderr.columns
        ? { terminalColumns: process.stderr.columns }
        : {}),
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
      local: {
        async proxyToken() {
          // Typed at a terminal the token would echo; a pipe keeps it off the screen and out of shell history.
          if (process.stdin.isTTY)
            throw new RigError(
              "PROXY_TOKEN",
              "rig proxy token reads the token from a pipe, not the keyboard.",
              "Copy the token, then run: pbpaste | rig proxy token",
            );
          return writeProxyToken(root, await Bun.stdin.text());
        },
        async proxyVerify(options) {
          const host = await readHostConfig(root);
          if (!host.proxy)
            throw new RigError(
              "PROXY_UNMANAGED",
              "Rig does not run its own Caddy on this Host.",
              "Add a proxy section to config.yaml under the Rig root and run rigd install.",
            );
          return verifyProxyCertificates({
            root,
            ...(options.port !== undefined ? { port: options.port } : {}),
            defaultPort: host.proxy.ports.https,
            stagingOk: options.stagingOk,
            waitMs: options.waitSeconds * 1000,
          });
        },
      },
    });
    return await finished(code);
  } finally {
    process.removeListener("SIGINT", interrupts.interrupt);
    process.removeListener("SIGTERM", interrupts.interrupt);
  }
}
/** CLI policy: only Doctor continues with read-only Host inspection when unavailable. `connection` is how each request
 * waits on rigd; the platform defaults when absent. */
export function createCliClient(
  root: string,
  cwd: string,
  connection: DaemonClientOptions = {},
): CliDependencies["client"] {
  return {
    async status(selection, signal) {
      return (await connectDaemon(root, connection)).status(selection, signal);
    },
    async command(request, signal) {
      try {
        return await (
          await connectDaemon(root, connection)
        ).command(request, signal);
      } catch (error) {
        if (request.action === "doctor" && isDaemonUnavailable(error)) {
          // The discovery rigd runs, so a linked worktree is checked against its main checkout's config.
          const documents = createProjectDocuments(
            root,
            runCommand,
            inheritedEnvironment(process.env),
            homedir(),
          );
          return inspectOfflineHost(root, request.repoPath ?? cwd, {
            inspectHost,
            discoverProject: (path) => documents.discover(path),
          });
        }
        throw error;
      }
    },
  };
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
