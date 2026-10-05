import { lstat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { ConfigError } from "../config/errors";
import {
  discoverProject,
  editProjectConfig,
  initializeProjectConfig,
  readHostConfig,
  readProjectConfig,
  resolveTargetPlan,
  scaffoldProjectConfig,
  upgradeProjectConfig,
} from "../config";
import type { ProjectDocuments } from "../runtime/contracts";
import type {
  ConfigDocument,
  HostConfig,
  ProjectConfig,
} from "../config/types";
import type { CommandRunner } from "../providers/contracts";
import type { RuntimeCommand } from "../daemon/protocol";
import { RigError } from "../domain/errors";
import { readProjectFile } from "./project-files";
import {
  createProjectDiscovery,
  inspectProjectLocation,
  ensureProjectGit,
  type ProjectDiscovery,
  type ProjectLocation,
} from "../git/project";
export function createProjectDocuments(
  root: string,
  run: CommandRunner,
  /** The environment git discovery runs with. */
  env: Readonly<Record<string, string>>,
  /** Absolute operator home that `~` in an env_file path means. */
  operatorHome: string,
): ProjectDocuments {
  const host = { operatorHome, envRoot: join(root, "env") };
  const discovery = createProjectDiscovery(run, env);
  // The adapter is the effect owner: it binds the config documents on disk once, here.
  const reads: InitializationReads = {
    discovery,
    discoverConfig: async (path, root) => {
      try {
        return await discoverProject(await searchStart(root, path), root);
      } catch (error) {
        if (error instanceof ConfigError && error.code === "missing_config")
          return undefined;
        throw error;
      }
    },
    hostConfig: () => readHostConfig(root),
  };
  return {
    async discover(path) {
      const location = await inspectProjectLocation(path, discovery);
      const found = await nearestConfigWithin(location, reads.discoverConfig);
      if (!found)
        throw new ConfigError(
          "No Project config found in this directory or its parents within the repository.",
          "missing_config",
          { startPath: path },
          "Run rig init in a repository, or select a registered Project.",
        );
      return { ...found, gitRequired: location.gitRequired };
    },
    read: readProjectConfig,
    readProjectFile,
    resolve: (input) => resolveTargetPlan(input, host),
    upgrade: (repoPath, options) =>
      upgradeProjectConfig({ repoPath, ...options }),
    host: () => readHostConfig(root),
    async initializationInfo(path) {
      const info = await inspectInitialization(
        path,
        { action: "init", createGit: true },
        reads,
      );
      return {
        name: info.name,
        productionBranch: info.productionBranch,
        ...(info.currentBranch ? { currentBranch: info.currentBranch } : {}),
        gitRequired: info.gitRequired,
        existing: !!info.existing,
      };
    },
    async identifyInitialization(path, command) {
      const { repoPath, name, existing } = await inspectInitialization(
        path,
        command,
        reads,
      );
      return {
        repoPath,
        name,
        ...(existing ? { configPath: existing.path } : {}),
      };
    },
    async initialize(path, command) {
      const { repoPath, name, existing, productionBranch } =
        await inspectInitialization(path, command, reads);
      // An invalid scaffold is refused before Git or the config file is touched.
      const scaffold = existing
        ? undefined
        : scaffoldProjectConfig({ ...command, name, productionBranch });
      await ensureProjectGit(
        { path: repoPath, createGit: command.createGit },
        discovery,
      );
      return existing ?? (await initializeProjectConfig(repoPath, scaffold!));
    },
    async rename(project, name) {
      const document = await readProjectConfig(project.repoPath);
      return await editProjectConfig({
        repoPath: project.repoPath,
        expectedRevision: document.revision,
        edits: [{ path: ["name"], value: name }],
      });
    },
  };
}
/** Everything initialization reads; the adapter binds the real documents, a test scripts them. */
export interface InitializationReads {
  discovery: ProjectDiscovery;
  /** The Project config the upward search finds, never above `root`, starting from `path` or, when the
   * repository at `root` lacks it as a plain directory of its own, the deepest parent it has as one;
   * undefined when there is none. */
  discoverConfig(
    path: string,
    root: string,
  ): Promise<
    { repoPath: string; document: ConfigDocument<ProjectConfig> } | undefined
  >;
  hostConfig(): Promise<HostConfig>;
}
/** Resolves where a Project would be initialized and under which name, without creating anything. */
export async function inspectInitialization(
  path: string,
  command: RuntimeCommand,
  reads: InitializationReads,
) {
  const { discovery } = reads;
  const location = await inspectProjectLocation(path, discovery);
  const { gitRequired } = location;
  if (gitRequired && !command.createGit)
    throw new RigError(
      "GIT_REQUIRED",
      "Rig needs a Git working repository.",
      "Explicitly use rig init --create-git.",
    );
  // The Project other commands discover is the nearest config at or above the path within the repository.
  const nearest = await nearestConfigWithin(location, reads.discoverConfig);
  const repoPath = nearest?.repoPath ?? location.repoPath;
  const existing = nearest?.document;
  const name =
    existing?.config.name ?? command.project ?? projectSlug(basename(repoPath));
  if (existing && command.project && command.project !== name)
    throw new RigError(
      "PROJECT_IDENTITY",
      "The requested name conflicts with Project config.",
      "Use the name declared by Project config.",
    );
  // The checked-out branch is never assumed to be Production; the host default stands in for origin/HEAD.
  const productionBranch =
    existing?.config.production_branch ??
    command.productionBranch ??
    location.productionBranch ??
    (await reads.hostConfig()).deploy.production_branch;
  return {
    repoPath,
    name,
    existing,
    productionBranch,
    currentBranch: location.currentBranch,
    gitRequired,
  };
}

/** The config the upward search finds from the location's place in the main working tree, provided
 * it lies inside the repository: a linked worktree selects the Project its main checkout registers. */
async function nearestConfigWithin(
  location: Pick<ProjectLocation, "repoPath" | "mainTreePath">,
  discoverConfig: InitializationReads["discoverConfig"],
): Promise<
  { repoPath: string; document: ConfigDocument<ProjectConfig> } | undefined
> {
  const root = location.repoPath;
  const found = await discoverConfig(location.mainTreePath, root);
  return found &&
    (found.repoPath === root || found.repoPath.startsWith(root + sep))
    ? found
    : undefined;
}
/** The deepest directory on the way from `root` to `path` that the repository at `root` holds as a
 * plain directory of its own. A linked worktree's Branch can hold a directory where the main tree has
 * nothing, a file, a symlink, or a separate repository (a `.git` entry); the search starts above it. */
async function searchStart(root: string, path: string): Promise<string> {
  let directory = root;
  for (const segment of relative(root, path).split(sep)) {
    if (!segment || segment === "..") break;
    const next = join(directory, segment);
    if (
      !(await entry(next))?.isDirectory() ||
      (await entry(join(next, ".git")))
    )
      break;
    directory = next;
  }
  return directory;
}
/** The entry itself, never a symlink's target; undefined when nothing is there. */
async function entry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function projectSlug(directory: string): string {
  return (
    directory
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}
