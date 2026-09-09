import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RigError } from "../domain/errors";
import { isGitCommit } from "../domain/git";
import type { CommandRunner } from "./contracts";
import { runCommand } from "./command-runner";
export interface SourceRequest {
  readonly project: string;
  readonly repository: string;
  readonly ref: string;
  readonly destination: string;
}
export interface SourceStore {
  prepare(
    request: SourceRequest,
  ): Promise<{ workspacePath: string; commit: string }>;
}
/** Rig owns all Git objects and worktree administration; developer repositories are inputs only. */
export function createGitSourceStore(options: {
  readonly root: string;
  readonly run?: CommandRunner;
}): SourceStore {
  const run = options.run ?? runCommand;
  const pending = new Map<string, Promise<unknown>>();
  async function git(args: readonly string[], cwd?: string): Promise<string> {
    const result = await run({ command: ["git", ...args], cwd });
    if (result.exitCode !== 0)
      throw new RigError(
        "GIT_FAILED",
        "Git could not prepare the deployment source.",
        "Check the repository and Branch or Commit, then retry.",
        { exitCode: result.exitCode, stderr: result.stderr },
      );
    return result.stdout.trim();
  }
  async function prepare(
    request: SourceRequest,
  ): Promise<{ workspacePath: string; commit: string }> {
    if (!request.ref || request.ref.startsWith("-"))
      throw new RigError(
        "GIT_REF",
        "The requested Git reference is invalid.",
        "Use a Branch name or Commit identifier.",
      );
    const commit = await git(
      ["rev-parse", "--verify", "--end-of-options", `${request.ref}^{commit}`],
      request.repository,
    );
    if (!isGitCommit(commit))
      throw new RigError(
        "GIT_COMMIT",
        "Git returned an invalid Commit identifier.",
        "Check the source repository.",
      );
    const mirror = join(
      options.root,
      `${createHash("sha256").update(request.project).digest("hex")}.git`,
    );
    await mkdir(options.root, { recursive: true });
    if (!(await exists(mirror))) {
      const temporary = `${mirror}.${randomUUID()}.tmp`;
      try {
        await git([
          "clone",
          "--mirror",
          "--no-hardlinks",
          "--dissociate",
          "--",
          resolve(request.repository),
          temporary,
        ]);
        await rename(temporary, mirror);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    // Fetch the exact resolved Commit. The independent mirror has no alternates or hardlinked objects.
    await git([
      "--git-dir",
      mirror,
      "fetch",
      "--no-tags",
      "--",
      resolve(request.repository),
      commit,
    ]);
    await mkdir(dirname(request.destination), { recursive: true });
    if (await exists(request.destination))
      throw new RigError(
        "WORKSPACE_EXISTS",
        "The deployment workspace already exists.",
        "Use a new deployment destination.",
        { path: request.destination },
      );
    await git([
      "--git-dir",
      mirror,
      "worktree",
      "add",
      "--detach",
      "--",
      resolve(request.destination),
      commit,
    ]);
    return { workspacePath: request.destination, commit };
  }
  return {
    async prepare(request) {
      const previous = pending.get(request.project) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(() => prepare(request));
      pending.set(request.project, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(request.project) === operation)
          pending.delete(request.project);
      }
    },
  };
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
