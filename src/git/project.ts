import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "../providers/contracts";
import { ensureRigRemote, rigRemoteUrl } from "./remotes";

export interface ProjectGit {
  repoPath: string;
  /** The branch origin/HEAD names; absent when the repository has no such remote head. */
  productionBranch?: string;
  /** The checked-out branch, or init.defaultBranch for a repository not yet created; absent when detached. */
  currentBranch?: string;
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

/** Discovery reads canonical filesystem paths and local Git metadata only; no fetch,
 * initialization or remote mutation. Adapters must return absolute canonical paths.
 * Failures: GIT_PATH_MISSING, GIT_PATH_UNREADABLE, GIT_REQUIRED, GIT_BARE,
 * GIT_DISCOVERY (command failure or malformed output). No raw output is exposed. */
export interface ProjectDiscovery {
  canonicalize(path: string): Promise<string>;
  run: CommandRunner;
}

/** Concrete OS acquisition stays here, shared by initialization and remote discovery. */
export function createProjectDiscovery(run: CommandRunner): ProjectDiscovery {
  const env = { ...process.env, LC_ALL: "C" };
  return {
    canonicalize: realpath,
    run: (input) =>
      run({ ...input, env: { ...env, ...input.env, LC_ALL: "C" } }),
  };
}

async function canonicalPath(
  path: string,
  discovery: ProjectDiscovery,
): Promise<string> {
  let canonical: string;
  try {
    canonical = await discovery.canonicalize(path);
  } catch (error) {
    const missing = (error as { code?: string })?.code === "ENOENT";
    throw new RigError(
      missing ? "GIT_PATH_MISSING" : "GIT_PATH_UNREADABLE",
      missing
        ? "The Project path does not exist."
        : "The Project path could not be read.",
      "Choose an accessible Project directory.",
    );
  }
  if (
    !isAbsolute(canonical) ||
    canonical.includes("\n") ||
    canonical.includes("\0")
  )
    throw discoveryFailure();
  return canonical;
}

function discoveryFailure(): RigError {
  return new RigError(
    "GIT_DISCOVERY",
    "Git Project discovery failed.",
    "Check Git availability and repository permissions.",
  );
}

async function readGit(
  cwd: string,
  args: string[],
  discovery: ProjectDiscovery,
) {
  try {
    return await discovery.run({ command: ["git", ...args], cwd });
  } catch {
    throw discoveryFailure();
  }
}

function branchValue(value: string): string {
  const branch = value.trim();
  if (!branch || /[\s\x00-\x1f]/.test(branch)) throw discoveryFailure();
  return branch;
}

/** Read-only location inspection also admits an existing non-repository directory
 * for initialization preview. gitRequired never authorizes a mutation. */
export async function inspectProjectLocation(
  path: string,
  discovery: ProjectDiscovery,
): Promise<ProjectGit & { gitRequired: boolean }> {
  const location = await canonicalPath(path, discovery);
  const bare = await readGit(
    location,
    ["rev-parse", "--is-bare-repository"],
    discovery,
  );
  if (bare.exitCode === 0 && bare.stdout.trim() === "true")
    throw new RigError(
      "GIT_BARE",
      "Rig needs a working repository, not a bare repository.",
      "Choose a checked-out Project directory.",
    );
  if (bare.exitCode !== 0) {
    // Git's documented diagnostic distinguishes an ordinary non-repository from
    // permissions/corruption/tool failures. It is classified here, never exposed.
    if (bare.exitCode !== 128 || !bare.stderr.includes("not a git repository"))
      throw discoveryFailure();
    const initial = await readGit(
      location,
      ["config", "--get", "init.defaultBranch"],
      discovery,
    );
    if (initial.exitCode !== 0 && initial.exitCode !== 1)
      throw discoveryFailure();
    return {
      repoPath: location,
      ...(initial.exitCode === 0
        ? { currentBranch: branchValue(initial.stdout) }
        : {}),
      gitRequired: true,
    };
  }
  if (bare.stdout.trim() !== "false") throw discoveryFailure();
  // The Project is the repository: a linked worktree resolves to the main working tree it shares.
  const worktrees = await readGit(
    location,
    ["worktree", "list", "--porcelain"],
    discovery,
  );
  const root = worktrees.stdout.match(/^worktree (.+)$/m)?.[1]?.trim();
  if (worktrees.exitCode !== 0 || !root || !isAbsolute(root))
    throw discoveryFailure();
  const repoPath = await canonicalPath(root, discovery);
  const remoteHead = await readGit(
    repoPath,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    discovery,
  );
  if (remoteHead.exitCode !== 0 && remoteHead.exitCode !== 1)
    throw discoveryFailure();
  if (
    remoteHead.exitCode === 0 &&
    !remoteHead.stdout.trim().startsWith("origin/")
  )
    throw discoveryFailure();
  // The checkout at the inspected path (a linked worktree keeps its own) is reported
  // separately: it is never the Production branch by itself.
  const current = await readGit(
    location,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    discovery,
  );
  if (current.exitCode !== 0 && current.exitCode !== 1)
    throw discoveryFailure();
  return {
    repoPath,
    ...(remoteHead.exitCode === 0
      ? { productionBranch: branchValue(remoteHead.stdout.trim().slice(7)) }
      : {}),
    ...(current.exitCode === 0
      ? { currentBranch: branchValue(current.stdout) }
      : {}),
    gitRequired: false,
  };
}

export async function inspectProjectGit(
  path: string,
  discovery: ProjectDiscovery,
): Promise<ProjectGit> {
  const { gitRequired, ...project } = await inspectProjectLocation(
    path,
    discovery,
  );
  if (gitRequired)
    throw new RigError(
      "GIT_REQUIRED",
      "Rig needs a Git working repository.",
      "Run inside a repository, or explicitly use rig init --create-git.",
    );
  return project;
}

/** Explicit setup changes only Git initialization and a missing conventional remote. */
export async function ensureProjectGit(
  input: EnsureProjectGitInput,
  discovery: ProjectDiscovery,
): Promise<ProjectGitSetup> {
  rigRemoteUrl(input.project); // Validate identity before any authorized Git initialization.
  let location = await inspectProjectLocation(input.path, discovery);
  let createdGit = false;
  if (location.gitRequired) {
    if (!input.createGit)
      throw new RigError(
        "GIT_REQUIRED",
        "Rig needs a Git working repository.",
        "Explicitly use rig init --create-git.",
      );
    const result = await readGit(location.repoPath, ["init"], discovery);
    if (result.exitCode !== 0)
      throw new RigError(
        "GIT_INIT",
        "Git repository initialization failed.",
        "Check the Project directory permissions.",
      );
    createdGit = true;
    location = {
      ...(await inspectProjectGit(location.repoPath, discovery)),
      gitRequired: false,
    };
  }
  const { gitRequired, ...project } = location;
  return {
    ...project,
    createdGit,
    ...(await ensureRigRemote(
      { repoPath: project.repoPath, project: input.project },
      discovery.run,
    )),
  };
}
