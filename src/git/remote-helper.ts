import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { RuntimeCommand } from "../daemon/protocol";
import { DaemonClient } from "../daemon/client";
import { readDaemonAddress, readDaemonToken } from "../daemon/files";
import { RigError, asRigError } from "../domain/errors";
import { isGitCommit } from "../domain/git";
import type { UserOutput } from "../cli/types";
import type { DiagnosticLog } from "../diagnostics/types";
import { createHostDiagnosticLog } from "../diagnostics/host-log";
import { recordDiagnostic } from "../cli/failure";
import { rigRoot, userOutput } from "../cli/entry-environment";
import { runCommand } from "../providers/command-runner";
import type { CommandRunner } from "../providers/contracts";
import { inspectProjectGit } from "./project";
import { targetName } from "../runtime/targets";

export interface RemoteHelperDependencies {
  repoPath: string;
  input: AsyncIterable<string>;
  output: UserOutput;
  client: { command(command: RuntimeCommand): Promise<unknown> };
  source: {
    resolve(ref: string): Promise<string>;
    verifyBranch(branch: string): Promise<void>;
  };
  newOperationId(): string;
  diagnostics?: DiagnosticLog;
}
interface PushRequest {
  source: string;
  destination: string;
  branch: string;
  force: boolean;
}
const commit = z
  .string()
  .refine(isGitCommit)
  .describe("Exact Git Commit identifier.");
const status = z.object({
  targets: z
    .array(
      z.object({
        name: z.string().describe("Recorded Target name."),
        kind: z
          .enum(["local", "live", "preview"])
          .describe("Recorded Target kind."),
        branch: z.string().optional().describe("Recorded destination Branch."),
        commit: commit.optional().describe("Recorded deployed Commit."),
      }),
    )
    .describe("Current recorded Targets."),
});
const completed = z.object({
  outcome: z
    .enum(["deployed", "unchanged"])
    .describe(
      "Final deployment outcome; transport acceptance is insufficient.",
    ),
});

/** Implements Git's push/option protocol. Stdout contains protocol frames only.
 * Protocol reference: https://git-scm.com/docs/gitremote-helpers
 * A push acknowledges an exact Commit only after rigd returns a final outcome.
 */
export async function runRemoteHelper(
  url: string,
  dependencies: RemoteHelperDependencies,
): Promise<number> {
  let project: string;
  try {
    project = projectFromRemote(url);
  } catch (error) {
    dependencies.output.error(`${asRigError(error).message}\n`);
    return 1;
  }
  const pending: PushRequest[] = [];
  let dryRun = false;
  let forced = false;
  let quiet = false;
  let failed = false;
  try {
    for await (const line of dependencies.input) {
      if (line === "capabilities") {
        dependencies.output.write("push\noption\n\n");
        continue;
      }
      if (line === "list for-push") {
        const report = status.parse(
          await dependencies.client.command({
            action: "status",
            project,
            repoPath: dependencies.repoPath,
          }),
        );
        const references = new Map<string, string>();
        const ambiguous = new Set<string>();
        for (const target of report.targets)
          if (target.branch && target.commit) {
            const canonical =
              target.kind === "live"
                ? target.name === "live"
                : target.kind === "preview" &&
                  target.name ===
                    targetName({
                      target: "preview",
                      branch: target.branch,
                    });
            if (!canonical) continue;
            await dependencies.source.verifyBranch(target.branch);
            const ref = `refs/heads/${target.branch}`;
            if (references.has(ref)) ambiguous.add(ref);
            references.set(ref, target.commit);
          }
        for (const ref of ambiguous) references.delete(ref);
        dependencies.output.write(
          [...references].map(([ref, value]) => `${value} ${ref}\n`).join("") +
            "\n",
        );
        continue;
      }
      if (line.startsWith("option ")) {
        const [, name, value] = line.split(" ");
        if (name === "dry-run" || name === "force") {
          if (value !== "true" && value !== "false")
            dependencies.output.write("error Expected true or false\n");
          else {
            if (name === "dry-run") dryRun = value === "true";
            else forced = value === "true";
            dependencies.output.write("ok\n");
          }
        } else if (name === "verbosity" && value && /^-?\d+$/.test(value)) {
          quiet = Number(value) <= 0;
          dependencies.output.write("ok\n");
        } else if (
          name === "progress" &&
          (value === "true" || value === "false")
        )
          dependencies.output.write("ok\n");
        else dependencies.output.write("unsupported\n");
        continue;
      }
      if (line.startsWith("push ")) {
        pending.push(parsePush(line));
        continue;
      }
      if (line === "") {
        if (!pending.length) break;
        for (const push of pending.splice(0)) {
          const operationId = dependencies.newOperationId();
          try {
            await dependencies.source.verifyBranch(push.branch);
            const resolved = commit.parse(
              await dependencies.source.resolve(push.source),
            );
            if (!dryRun) {
              await diagnostic(dependencies, {
                event: "command.started",
                action: "git-push",
                project,
                operationId,
              });
              const result = completed.parse(
                await dependencies.client.command({
                  action: "git-push",
                  project,
                  repoPath: dependencies.repoPath,
                  branch: push.branch,
                  commit: resolved,
                  operationId,
                  ...(push.force || forced ? { force: true } : {}),
                }),
              );
              await diagnostic(dependencies, {
                event: "command.completed",
                action: "git-push",
                project,
                operationId,
                outcome: result.outcome,
              });
              if (!quiet)
                dependencies.output.error(
                  `${project} ${push.branch} ${result.outcome}\n`,
                );
            }
            dependencies.output.write(`ok ${push.destination}\n`);
          } catch (error) {
            failed = true;
            const failure = asRigError(error);
            await diagnostic(dependencies, {
              event: "command.failed",
              level: "error",
              action: "git-push",
              project,
              operationId,
              code: failure.code,
            });
            dependencies.output.write(
              `error ${push.destination} ${oneLine(failure.message)}\n`,
            );
            dependencies.output.error(
              `${failure.hint}\nOperation: ${operationId}\n`,
            );
          }
        }
        dependencies.output.write("\n");
        continue;
      }
      throw new RigError(
        "GIT_PROTOCOL",
        "The Rig remote supports push only.",
        "Use rig status or rig deploy for local deployment inspection.",
      );
    }
    if (pending.length)
      throw new RigError(
        "GIT_PROTOCOL",
        "The Git push batch ended before its terminator.",
        "Retry git push.",
      );
    return failed ? 1 : 0;
  } catch (error) {
    const failure = asRigError(error);
    dependencies.output.error(`${failure.message}\n${failure.hint}\n`);
    return 1;
  }
}
function projectFromRemote(value: string): string {
  const match = /^rig:\/\/localhost\/([a-zA-Z0-9][a-zA-Z0-9_-]*)$/.exec(value);
  if (!match)
    throw new RigError(
      "GIT_REMOTE",
      "The Rig remote must use rig://localhost/<project>.",
      "Inspect git remote -v and the registered Project identity.",
    );
  return match[1]!;
}
function parsePush(line: string): PushRequest {
  const match = /^push (\+?)([^\s:]*):(refs\/heads\/[^\s:]+)$/.exec(line);
  if (!match || !match[2])
    throw new RigError(
      "GIT_PUSH_REF",
      "Rig pushes require a source Commit and a destination Branch; deletion is unsupported.",
      "Push a Branch, such as git push rig main.",
    );
  return {
    source: match[2]!,
    destination: match[3]!,
    branch: match[3]!.slice("refs/heads/".length),
    force: match[1] === "+",
  };
}
function oneLine(value: string): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]/g, " ");
}
async function diagnostic(
  dependencies: RemoteHelperDependencies,
  entry: Parameters<DiagnosticLog["record"]>[0],
): Promise<void> {
  if (!dependencies.diagnostics) return;
  const result = await recordDiagnostic(dependencies.diagnostics, entry);
  if (result.error) dependencies.output.error(`${result.error}\n`);
}
export function createGitPushSource(
  repoPath: string,
  run: CommandRunner,
): RemoteHelperDependencies["source"] {
  return {
    async resolve(ref) {
      if (!ref || ref.startsWith("-"))
        throw new RigError(
          "GIT_REF",
          "The source Commit is invalid.",
          "Choose a local Branch or Commit.",
        );
      const result = await run({
        command: [
          "git",
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${ref}^{commit}`,
        ],
        cwd: repoPath,
      });
      if (result.exitCode !== 0)
        throw new RigError(
          "GIT_REF",
          "The pushed source does not resolve to a Commit.",
          "Create a commit or correct the source ref.",
        );
      return commit.parse(result.stdout.trim());
    },
    async verifyBranch(branch) {
      const result = await run({
        command: ["git", "check-ref-format", `refs/heads/${branch}`],
        cwd: repoPath,
      });
      if (result.exitCode !== 0)
        throw new RigError(
          "GIT_BRANCH",
          "The destination Branch is invalid.",
          "Choose a valid Git Branch name.",
        );
    },
  };
}

/** Executable effect owner. Git provides the remote name and URL as argv. */
export async function main(args: readonly string[]): Promise<number> {
  const output = userOutput();
  if (args.includes("--help") || args.includes("-h")) {
    output.write(
      "Usage: git-remote-rig <remote> [rig://localhost/<project>]\nInvoked by git push rig <branch>.\n",
    );
    return 0;
  }
  const url = args[1] ?? args[0];
  if (!url) {
    output.error("Git did not supply a Rig remote URL.\n");
    return 1;
  }
  try {
    const { repoPath } = await inspectProjectGit(process.cwd(), runCommand);
    const root = rigRoot();
    return await runRemoteHelper(url, {
      repoPath,
      input: createInterface({ input: process.stdin, crlfDelay: Infinity }),
      output,
      newOperationId: randomUUID,
      source: createGitPushSource(repoPath, runCommand),
      diagnostics: createHostDiagnosticLog({
        root,
        source: "rig",
        now: () => new Date(),
      }),
      client: {
        async command(command) {
          const address = await readDaemonAddress(root);
          if (!address)
            throw new RigError(
              "DAEMON_MISSING",
              "rigd is not reachable.",
              "Run rigd status or install the daemon with rigd install.",
            );
          return await new DaemonClient({
            port: address.port,
            token: await readDaemonToken(root),
          }).command(command);
        },
      },
    });
  } catch (error) {
    const failure = asRigError(error);
    output.error(`${failure.message}\n${failure.hint}\n`);
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
