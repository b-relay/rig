import { realpath } from "node:fs/promises";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "../providers/contracts";
import { ensureRigRemote, rigRemoteUrl } from "./remotes";

export interface ProjectGit {
  repoPath: string;
  productionBranch: string;
}
export interface EnsureProjectGitInput {
  path: string;
  project: string;
  createGit?: boolean;
}
export interface ProjectGitSetup extends ProjectGit {
  createdGit: boolean;
  remoteConfigured: boolean;
  remoteUrl: string;
}

/** Read-only discovery from any nested directory, including unborn repositories. */
export async function inspectProjectGit(
  path: string,
  run: CommandRunner,
): Promise<ProjectGit> {
  const location = await realpath(path);
  const root = await run({
    command: ["git", "rev-parse", "--show-toplevel"],
    cwd: location,
  });
  if (root.exitCode !== 0 || !root.stdout.trim())
    throw new RigError(
      "GIT_REQUIRED",
      "Rig needs a Git working repository.",
      "Run inside a repository, or explicitly use rig init --create-git.",
    );
  const repoPath = await realpath(root.stdout.trim());
  const remoteHead = await run({
    command: ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd: repoPath,
  });
  if (
    remoteHead.exitCode === 0 &&
    remoteHead.stdout.trim().startsWith("origin/")
  )
    return { repoPath, productionBranch: remoteHead.stdout.trim().slice(7) };
  const current = await run({
    command: ["git", "symbolic-ref", "--short", "HEAD"],
    cwd: repoPath,
  });
  return {
    repoPath,
    productionBranch:
      current.exitCode === 0 && current.stdout.trim()
        ? current.stdout.trim()
        : "main",
  };
}

/** Explicit setup changes only Git initialization and a missing conventional remote. */
export async function ensureProjectGit(
  input: EnsureProjectGitInput,
  run: CommandRunner,
): Promise<ProjectGitSetup> {
  rigRemoteUrl(input.project); // Validate identity before any authorized Git initialization.
  let project: ProjectGit;
  let createdGit = false;
  try {
    project = await inspectProjectGit(input.path, run);
  } catch (error) {
    if (
      !(error instanceof RigError) ||
      error.code !== "GIT_REQUIRED" ||
      !input.createGit
    )
      throw error;
    const bare = await run({
      command: ["git", "rev-parse", "--is-bare-repository"],
      cwd: input.path,
    });
    if (bare.exitCode === 0 && bare.stdout.trim() === "true")
      throw new RigError(
        "GIT_BARE",
        "Rig needs a working repository, not a bare repository.",
        "Choose a checked-out Project directory.",
      );
    const result = await run({ command: ["git", "init"], cwd: input.path });
    if (result.exitCode !== 0)
      throw new RigError(
        "GIT_INIT",
        "Git repository initialization failed.",
        "Check the Project directory permissions.",
      );
    createdGit = true;
    project = await inspectProjectGit(input.path, run);
  }
  return {
    ...project,
    createdGit,
    ...(await ensureRigRemote(
      { repoPath: project.repoPath, project: input.project },
      run,
    )),
  };
}
