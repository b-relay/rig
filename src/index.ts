import { waitForLogPoll } from "./adapters/log-follow-scheduler";
import { createTerminalInteraction } from "./adapters/terminal-interaction";
import { randomUUID } from "node:crypto";
import { runRigCli } from "./cli/rig";
import {
  interruptLadder,
  reportRootFailure,
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
  // A reader that has gone away ends the command the way Ctrl-C does; rigd keeps running whatever it was asked.
  const output = userOutput(interrupts.interrupt);
  let root: string;
  try {
    root = rigRoot();
    await verifyRigRoot(root);
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
      now: () => new Date(),
      liveOutput: process.stderr.isTTY === true,
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
            port: options.port ?? host.proxy.ports.https,
            stagingOk: options.stagingOk,
            waitMs: options.waitSeconds * 1000,
          });
        },
      },
    });
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
    async status(selection) {
      return (await connectDaemon(root, connection)).status(selection);
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
