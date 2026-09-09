import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RuntimeCommand } from "../daemon/protocol";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import { RigError } from "../domain/errors";
import type { RuntimeDependencies } from "./contracts";
import { recordedPorts } from "./ports";
export function targetName(
  command: Pick<RuntimeCommand, "target" | "deployment" | "branch">,
): string {
  if (command.target !== "preview") return command.target ?? "local";
  if (command.deployment) {
    if (["local", "live"].includes(command.deployment))
      throw new RigError(
        "PREVIEW_NAME",
        "Preview names cannot be local or live.",
        "Choose a distinct Preview deployment name.",
      );
    return command.deployment;
  }
  if (!command.branch)
    throw new RigError(
      "PREVIEW_REQUIRED",
      "Select a Preview Branch or deployment name.",
      "Pass a Branch or --deployment.",
    );
  const slug =
    command.branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "branch";
  return `${slug}-${createHash("sha256").update(command.branch).digest("hex").slice(0, 8)}`;
}
export async function planTarget(
  input: {
    command: RuntimeCommand;
    project: ProjectRecord;
    document: ConfigDocument<ProjectConfig>;
    existing?: TargetRecord;
  },
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  const { command, project, document, existing } = input;
  const kind = command.target ?? "local";
  const name = targetName(command);
  if (
    existing &&
    (existing.kind !== kind ||
      existing.name !== name ||
      existing.projectId !== project.id)
  )
    throw new RigError(
      "TARGET_IDENTITY",
      "The selected Target has a different identity.",
      "Select the correct Target kind and name.",
    );
  const id = existing?.id ?? deps.id();
  const base = join(deps.root, "targets", project.id, id);
  let workspacePath = project.repoPath,
    commit: string | undefined,
    branch = command.branch;
  if (kind !== "local") {
    const host = await deps.documents.host();
    const production =
      document.config.live?.deployBranch ?? host.deploy.productionBranch;
    branch =
      branch ??
      (kind === "live"
        ? production
        : await deps.sources.currentBranch(project.repoPath));
    if (
      (kind === "live" && branch !== production) ||
      (kind === "preview" && branch === production)
    )
      throw new RigError(
        "BRANCH_POLICY",
        `Branch '${branch}' does not match this Target's deployment policy.`,
        "Deploy the Production Branch to live and other Branches to Previews.",
      );
    const prepared = await deps.sources.prepare({
      project: project.id,
      repository: project.repoPath,
      ref: command.commit ?? branch,
      destination: join(base, "revisions", deps.id()),
    });
    workspacePath = prepared.workspacePath;
    commit = prepared.commit;
  }
  const planInput = {
    config: document.config,
    target: kind,
    workspacePath,
    dataRoot: existing?.plan.dataRoot ?? join(base, "data"),
    deploymentName: name,
    branchSlug: name,
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
  };
  const state = await deps.store.read();
  const occupied = new Set(
    state.targets
      .filter((t) => t.id !== id)
      .flatMap((t) =>
        t.plan.components.flatMap((c) =>
          c.kind === "managed"
            ? [c.port, ...(c.sitePort ? [c.sitePort] : [])]
            : [],
        ),
      ),
  );
  const lane =
    kind === "local"
      ? document.config.local
      : kind === "live"
        ? document.config.live
        : document.config.deployments;
  const requests = Object.entries(document.config.components).flatMap(
    ([name, base]) => {
      const component = { ...base, ...lane?.components?.[name] };
      if (
        ("mode" in component && component.mode === "managed") ||
        ("uses" in component && component.uses !== "sqlite")
      )
        return [
          { name, preferred: "port" in component ? component.port : undefined },
          ...("uses" in component && component.uses === "convex"
            ? [
                {
                  name: `${name}.site`,
                  preferred:
                    "sitePort" in component ? component.sitePort : undefined,
                },
              ]
            : []),
        ];
      return [];
    },
  );
  const previousPorts: Record<string, number> = existing
    ? recordedPorts(existing.plan.components)
    : {};
  const prior = Object.fromEntries(
    requests
      .filter(
        (request) =>
          previousPorts[request.name] !== undefined &&
          (kind === "preview" ||
            request.preferred === undefined ||
            request.preferred === previousPorts[request.name]),
      )
      .map((request) => [request.name, previousPorts[request.name]!]),
  );
  const allocated = await deps.files.reservePorts(
    requests.filter((r) => !prior[r.name]),
    occupied,
    kind === "preview",
  );
  const assignedPorts = { ...prior, ...allocated };
  const plan = deps.documents.resolve({ ...planInput, assignedPorts });
  return {
    id,
    projectId: project.id,
    name,
    kind,
    branch,
    commit,
    plan,
    desired: "stopped",
    createdAt: existing?.createdAt ?? deps.now(),
    updatedAt: deps.now(),
    logRoot: existing?.logRoot ?? join(base, "logs"),
    ...(kind !== "local" ? { sourceRoot: join(base, "revisions") } : {}),
  };
}
export async function persistTarget(
  target: TargetRecord,
  deps: RuntimeDependencies,
): Promise<void> {
  await deps.store.update((state) => {
    const index = state.targets.findIndex((t) => t.id === target.id);
    if (index === -1) state.targets.push(target);
    else state.targets[index] = target;
  });
}
