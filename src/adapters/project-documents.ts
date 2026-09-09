import { basename } from "node:path";
import { ConfigError } from "../config/errors";
import {
  discoverProject,
  editProjectConfig,
  initializeProjectConfig,
  readHostConfig,
  readProjectConfig,
  resolveTargetPlan,
} from "../config";
import type { ProjectDocuments } from "../runtime/contracts";
import type { CommandRunner } from "../providers/contracts";
import type { RuntimeCommand } from "../daemon/protocol";
import { RigError } from "../domain/errors";
import { renameRigRemote } from "../git/remotes";
import {
  createProjectDiscovery,
  inspectProjectLocation,
  ensureProjectGit,
  type ProjectDiscovery,
} from "../git/project";
export function createProjectDocuments(
  root: string,
  run: CommandRunner,
): ProjectDocuments {
  const discovery = createProjectDiscovery(run);
  return {
    discover: discoverProject,
    read: readProjectConfig,
    resolve: resolveTargetPlan,
    host: () => readHostConfig(root),
    async initializationInfo(path) {
      const info = await inspectInitialization(
        path,
        { action: "init", createGit: true },
        discovery,
      );
      return {
        name: info.name,
        productionBranch: info.productionBranch,
        gitRequired: info.gitRequired,
        existing: !!info.existing,
      };
    },
    async identifyInitialization(path, command) {
      const { repoPath, name } = await inspectInitialization(
        path,
        command,
        discovery,
      );
      return { repoPath, name };
    },
    async initialize(path, command) {
      const { repoPath, name, existing, productionBranch } =
        await inspectInitialization(path, command, discovery);
      await ensureProjectGit(
        { path: repoPath, project: name, createGit: command.createGit },
        discovery,
      );
      if (existing) return existing;
      return await initializeProjectConfig(repoPath, {
        ...command,
        name,
        productionBranch: command.productionBranch ?? productionBranch,
      });
    },
    async rename(project, name) {
      const document = await readProjectConfig(project.repoPath);
      const remote = await renameRigRemote(
        { repoPath: project.repoPath, oldName: project.name, newName: name },
        run,
      );
      try {
        return await editProjectConfig({
          repoPath: project.repoPath,
          expectedRevision: document.revision,
          edits: [{ path: ["name"], value: name }],
        });
      } catch (error) {
        await remote.restore();
        throw error;
      }
    },
  };
}
async function inspectInitialization(
  path: string,
  command: RuntimeCommand,
  discovery: ProjectDiscovery,
) {
  const { repoPath, productionBranch, gitRequired } =
    await inspectProjectLocation(path, discovery);
  if (gitRequired && !command.createGit)
    throw new RigError(
      "GIT_REQUIRED",
      "Rig needs a Git working repository.",
      "Explicitly use rig init --create-git.",
    );
  let existing;
  try {
    existing = await readProjectConfig(repoPath);
  } catch (error) {
    if (!(error instanceof ConfigError) || error.code !== "missing_config")
      throw error;
  }
  const name =
    existing?.config.name ?? command.project ?? projectSlug(basename(repoPath));
  if (existing && command.project && command.project !== name)
    throw new RigError(
      "PROJECT_IDENTITY",
      "The requested name conflicts with Project config.",
      "Use the name declared by Project config.",
    );
  return {
    repoPath,
    name,
    existing,
    productionBranch: existing?.config.live?.deployBranch ?? productionBranch,
    gitRequired,
  };
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
