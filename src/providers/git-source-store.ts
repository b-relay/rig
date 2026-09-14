import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { RigError } from "../domain/errors";
import { isGitCommit } from "../domain/git";
import type { CommandRunner } from "./contracts";
/** Repository and destination are absolute paths; the store never resolves against a working directory. */
export interface SourceRequest {
  readonly project: string;
  readonly repository: string;
  readonly ref: string;
  readonly destination: string;
}
/** A prepared workspace to give back; the directory may already be gone. */
export interface ReleaseRequest {
  readonly project: string;
  readonly workspacePath: string;
}
export interface SourceStore {
  prepare(
    request: SourceRequest,
  ): Promise<{ workspacePath: string; commit: string }>;
  /** Remove the workspace's checkout, including untracked install output, and drop its worktree
   * registration from the Project mirror. A workspace deleted by hand is only pruned. */
  release(request: ReleaseRequest): Promise<void>;
}
/** Rig owns all Git objects and worktree administration; developer repositories are inputs only. Git runs through `run`. */
export function createGitSourceStore(options: {
  readonly root: string;
  readonly run: CommandRunner;
}): SourceStore {
  const { run } = options;
  const pending = new Map<string, Promise<unknown>>();
  const mirrorPath = (project: string) =>
    join(
      options.root,
      `${createHash("sha256").update(project).digest("hex")}.git`,
    );
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
    for (const [name, value] of [
      ["repository", request.repository],
      ["destination", request.destination],
    ] as const)
      if (!isAbsolute(value))
        throw new RigError(
          "SOURCE_PATH",
          `The deployment source ${name} must be an absolute path.`,
          "Pass an absolute path; rigd does not resolve paths against its working directory.",
          { [name]: value },
        );
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
    const mirror = mirrorPath(request.project);
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
          request.repository,
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
      request.repository,
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
      request.destination,
      commit,
    ]);
    return { workspacePath: request.destination, commit };
  }
  async function release(request: ReleaseRequest): Promise<void> {
    if (!isAbsolute(request.workspacePath))
      throw new RigError(
        "SOURCE_PATH",
        "The deployment workspace must be an absolute path.",
        "Pass an absolute path; rigd does not resolve paths against its working directory.",
        { workspacePath: request.workspacePath },
      );
    const mirror = mirrorPath(request.project);
    const registered = await exists(mirror);
    if (await exists(request.workspacePath)) {
      if (registered)
        await git([
          "--git-dir",
          mirror,
          "worktree",
          "remove",
          "--force",
          "--",
          request.workspacePath,
        ]);
      else await rm(request.workspacePath, { recursive: true, force: true });
    }
    if (registered) await git(["--git-dir", mirror, "worktree", "prune"]);
  }
  // Worktree administration on one mirror runs one operation at a time.
  async function serialized<T>(
    project: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = pending.get(project) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    pending.set(project, current);
    try {
      return await current;
    } finally {
      if (pending.get(project) === current) pending.delete(project);
    }
  }
  return {
    prepare: (request) => serialized(request.project, () => prepare(request)),
    release: (request) => serialized(request.project, () => release(request)),
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
