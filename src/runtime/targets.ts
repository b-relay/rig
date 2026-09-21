import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RuntimeCommand } from "../daemon/protocol";
import type {
  ProjectRecord,
  TargetRecord,
  StateStore,
} from "../domain/runtime";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import { RigError } from "../domain/errors";
import type { RuntimeDependencies } from "./contracts";
import { portOwners, recordedPorts } from "./ports";
import {
  PREVIEW_SELECTOR,
  patchedSettings,
  targetNames,
} from "../config/schema";
type TargetKind = TargetRecord["kind"];
const KIND_OF = { working: "local", stable: "live" } as const;
const ROLE_OF = { local: "working", live: "stable" } as const;
/** The generated name of a Branch's Preview, or the explicit deployment name. */
export function previewName(
  command: Pick<RuntimeCommand, "deployment" | "branch">,
): string {
  if (command.deployment) return command.deployment;
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
/** Which Target a command's selector means. The selector is `preview`, the configured name of the Working copy or
 * Stable Target, or a name one of them is still recorded under, so a Target stays reachable while its config is unreadable
 * or names it differently. No selector means the Working copy. `name` is absent for a Working copy or Stable Target nothing names yet.
 * Rejects TARGET_UNKNOWN for any other selector, TARGET_AMBIGUOUS for a name configured for one Target while the other is still recorded under it, and PREVIEW_NAME for a new Preview named like the Working copy or Stable Target. */
export function selectTarget(
  command: Pick<RuntimeCommand, "target" | "deployment" | "branch">,
  configured: Readonly<Record<"working" | "stable", string>> | undefined,
  recorded: readonly Pick<TargetRecord, "kind" | "name">[],
): { kind: TargetKind; name?: string } {
  const named = (kind: "local" | "live") =>
    configured?.[ROLE_OF[kind]] ?? recorded.find((t) => t.kind === kind)?.name;
  const known = (["local", "live"] as const).flatMap((kind) => [
    ...(configured ? [configured[ROLE_OF[kind]]] : []),
    ...recorded.filter((t) => t.kind === kind).map((t) => t.name),
  ]);
  if (command.target === PREVIEW_SELECTOR) {
    const name = previewName(command);
    // A Preview recorded before the name was taken stays selectable, so it can still be stopped or destroyed.
    if (
      known.includes(name) &&
      !recorded.some((t) => t.kind === "preview" && t.name === name)
    )
      throw new RigError(
        "PREVIEW_NAME",
        `'${name}' names this Project's Working copy or Stable Target.`,
        "Choose a distinct Preview deployment name.",
      );
    return { kind: "preview", name };
  }
  if (command.target === undefined)
    return { kind: "local", name: named("local") };
  const role = (["working", "stable"] as const).find(
    (role) => configured?.[role] === command.target,
  );
  const holder = recorded.find(
    (t) => t.kind !== "preview" && t.name === command.target,
  )?.kind;
  // Mid-rename a name can be configured for one Target while the other is still recorded under it; guessing could stop the wrong one.
  if (role && holder && holder !== "preview" && holder !== KIND_OF[role])
    throw new RigError(
      "TARGET_AMBIGUOUS",
      `'${command.target}' is the configured name of one Target and still the recorded name of the other.`,
      `Select by the other configured name (${configured![ROLE_OF[holder]]}) first; planning that Target again (rig up, or a deploy) records its new name.`,
    );
  const kind = role ? KIND_OF[role] : holder;
  if (!kind || kind === "preview")
    throw new RigError(
      "TARGET_UNKNOWN",
      `This Project has no Target named '${command.target}'.`,
      `Select ${[...new Set(known)].join(", ") || "a configured Target"} or ${PREVIEW_SELECTOR}.`,
    );
  return { kind, name: named(kind) };
}
export async function planTarget(
  input: {
    command: RuntimeCommand;
    /** The selected Target's kind; its name comes from the config the plan is made from. */
    kind: TargetKind;
    project: ProjectRecord;
    document: ConfigDocument<ProjectConfig>;
    existing?: TargetRecord;
  },
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  const { command, kind, project, document, existing } = input;
  if (
    existing &&
    (existing.kind !== kind ||
      (kind === "preview" && existing.name !== previewName(command)) ||
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
    branch = command.branch,
    config = document.config;
  if (kind !== "local") {
    const host = await deps.documents.host();
    const production =
      document.config.production_branch ?? host.deploy.productionBranch;
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
        "Deploy the Production Branch to the Stable Target and other Branches to Previews.",
      );
    const prepared = await deps.sources.prepare({
      project: project.id,
      repository: project.repoPath,
      ref: command.commit ?? branch,
      destination: join(base, "revisions", deps.id()),
    });
    workspacePath = prepared.workspacePath;
    commit = prepared.commit;
    // The deployed revision serves its own committed config; the working copy only identified the Project.
    config = await committedConfig(prepared.workspacePath, project, deps);
  }
  const name =
    kind === "preview"
      ? previewName(command)
      : targetNames(config)[ROLE_OF[kind]];
  const targets = (await deps.store.read()).targets;
  // A Working copy or Stable Target keeps its identity under a new configured name, but never takes another Target's.
  const holder =
    kind === "preview"
      ? undefined
      : targets.find(
          (t) => t.projectId === project.id && t.id !== id && t.name === name,
        );
  if (holder)
    throw new RigError(
      "TARGET_NAME",
      holder.kind === "preview"
        ? `Target name '${name}' already belongs to a Preview of this Project.`
        : `Target name '${name}' is still recorded for this Project's other Target.`,
      holder.kind === "preview"
        ? `Choose another targets.${ROLE_OF[kind as "local" | "live"]}.name, or destroy that Preview first.`
        : `Plan the other Target under its new name first (rig up, or a deploy), or choose another targets.${ROLE_OF[kind as "local" | "live"]}.name.`,
    );
  const planInput = {
    config,
    target: kind,
    workspacePath,
    dataRoot: existing?.plan.dataRoot ?? join(base, "data"),
    deploymentName: name,
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
  };
  const owners = portOwners(targets, id);
  const settings = patchedSettings(
    config,
    kind === "preview" ? "preview" : ROLE_OF[kind],
  );
  const requests = Object.entries(settings.services ?? {}).flatMap(
    ([name, service]) =>
      Object.entries(service.ports ?? {}).map(([port, value], index) => ({
        name: `${name}.${port}`,
        // A plan recorded before named ports kept its one assignment under the Service's name.
        legacy: index === 0 ? name : undefined,
        preferred: value === "auto" ? undefined : value,
      })),
  );
  const recorded: Record<string, number> = existing
    ? recordedPorts(existing.plan.components)
    : {};
  const previous = (request: (typeof requests)[number]) =>
    recorded[request.name] ??
    (request.legacy === undefined ? undefined : recorded[request.legacy]);
  const prior = Object.fromEntries(
    requests
      .filter(
        (request) =>
          previous(request) !== undefined &&
          (kind === "preview" ||
            request.preferred === undefined ||
            request.preferred === previous(request)),
      )
      .map((request) => [request.name, previous(request)!]),
  );
  const selected = await deps.files.selectPorts({
    requests: requests.filter((r) => !prior[r.name]),
    occupied: owners,
    policy: kind === "preview" ? "dynamic" : "configured",
  });
  const assignedPorts = { ...prior, ...selected };
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
    ...(kind !== "local"
      ? { sourceRoot: join(base, "revisions") }
      : { configRevision: document.revision }),
  };
}
export async function persistTarget(
  target: TargetRecord,
  store: Pick<StateStore, "update">,
): Promise<void> {
  await store.update((state) => {
    const index = state.targets.findIndex((t) => t.id === target.id);
    if (index === -1) state.targets.push(target);
    else state.targets[index] = target;
  });
}
/** The rig config committed on a prepared revision; a revision that names another Project is never deployed here. */
async function committedConfig(
  workspacePath: string,
  project: ProjectRecord,
  deps: Pick<RuntimeDependencies, "documents">,
): Promise<ProjectConfig> {
  const revision = await deps.documents.read(workspacePath);
  if (revision.config.name !== project.name)
    throw new RigError(
      "PROJECT_IDENTITY",
      `The deployed revision's rig config names Project '${revision.config.name}', not '${project.name}'.`,
      "Deploy a Commit whose rig config keeps this Project's name, or run rig rename.",
      { revisionPath: revision.path },
    );
  return revision.config;
}
