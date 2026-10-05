import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RuntimeCommand } from "../daemon/protocol";
import type {
  ProjectRecord,
  TargetRecord,
  StateStore,
} from "../domain/runtime";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import { configDigest } from "../config/config-digest";
import { RigError } from "../domain/errors";
import type { RuntimeDependencies } from "./contracts";
import { portOwners, recordedPorts } from "./ports";
import type { PortOwner } from "./host-reservations";
import {
  PREVIEW_SELECTOR,
  WORKING_TOOL_SUFFIX,
  patchedSettings,
  targetOn,
  type TargetRole,
} from "../config/schema";
type TargetKind = TargetRecord["kind"];
/** Names no new Preview may take: the working and stable Targets' names, and `dev`, which the working Target's Tools are
 * published under (`<tool>-dev`), so a Preview named so would claim the same executables. */
const RESERVED_PREVIEW_NAMES: readonly string[] = [
  "working",
  "stable",
  WORKING_TOOL_SUFFIX,
];
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
/** Which Target a command's selector means: `working`, `stable`, or `preview` with a Branch or deployment name. No selector
 * means the working Target. The working and stable Targets are named by their role, so a recorded one is found by its kind.
 * Rejects TARGET_UNKNOWN for any other selector, and PREVIEW_NAME for a new Preview that would take a reserved name; a Preview
 * recorded under such a name before it was reserved stays selectable, so it can still be stopped or destroyed. */
export function selectTarget(
  command: Pick<RuntimeCommand, "target" | "deployment" | "branch">,
  recorded: readonly Pick<TargetRecord, "kind" | "name">[],
): { kind: TargetKind; name: string } {
  if (command.target === PREVIEW_SELECTOR) {
    const name = previewName(command);
    if (
      RESERVED_PREVIEW_NAMES.includes(name) &&
      !recorded.some((t) => t.kind === "preview" && t.name === name)
    )
      throw new RigError(
        "PREVIEW_NAME",
        `'${name}' is reserved: ${name === WORKING_TOOL_SUFFIX ? "the working Target's Tools are published as <tool>-dev" : "it names this Project's working or stable Target"}.`,
        "Choose another Preview deployment name.",
      );
    return { kind: "preview", name };
  }
  if (command.target === undefined) return { kind: "working", name: "working" };
  if (command.target === "working" || command.target === "stable")
    return { kind: command.target, name: command.target };
  throw new RigError(
    "TARGET_UNKNOWN",
    `This Project has no Target named '${command.target}'.`,
    "Target names are fixed: select working, stable, or preview with a Branch.",
  );
}
/** Refuses TARGET_OFF when rig.yaml leaves the role off: a command that would select, start, deploy or publish an off Target
 * does nothing. The hint names the one line that turns it on. */
export function assertTargetOn(
  config: Pick<ProjectConfig, "targets">,
  role: TargetRole,
): void {
  if (targetOn(config, role)) return;
  const label = role === "preview" ? "Previews are" : `The ${role} Target is`;
  throw new RigError(
    "TARGET_OFF",
    `${label} off in rig.yaml.`,
    config.targets?.[role] === false
      ? `Change \`${role}: false\` to \`${role}: true\` under targets in rig.yaml.`
      : config.targets === undefined
        ? `Add a targets key to rig.yaml with \`${role}: true\` under it, and \`working: true\` beside it to keep the working Target on.`
        : `Add \`${role}: true\` under targets in rig.yaml.`,
    { role },
  );
}
export async function planTarget(
  input: {
    command: RuntimeCommand;
    /** The selected Target's kind; the working and stable Targets are named by it. */
    kind: TargetKind;
    project: ProjectRecord;
    document: ConfigDocument<ProjectConfig>;
    existing?: TargetRecord;
    /** The Commit a deploy resolved; its revision is prepared from exactly this, not from the Branch again. */
    commit?: string;
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
  if (kind !== "working") {
    const host = await deps.documents.host();
    const production =
      document.config.production_branch ?? host.deploy.production_branch;
    branch =
      branch ??
      (kind === "stable"
        ? production
        : await deps.sources.currentBranch(project.repoPath));
    if (
      (kind === "stable" && branch !== production) ||
      (kind === "preview" && branch === production)
    )
      throw new RigError(
        "BRANCH_POLICY",
        `Branch '${branch}' does not match this Target's deployment policy.`,
        "Deploy the Production Branch to the stable Target and other Branches to Previews.",
      );
    const prepared = await deps.sources.prepare({
      project: project.id,
      repository: project.repoPath,
      ref: input.commit ?? branch,
      destination: join(base, "revisions", deps.id()),
    });
    workspacePath = prepared.workspacePath;
    commit = prepared.commit;
    // The deployed revision serves its own committed config; the working copy only identified the Project.
    config = await committedConfig(prepared.workspacePath, project, deps);
  }
  const name = kind === "preview" ? previewName(command) : kind;
  const targets = (await deps.store.read()).targets;
  // A Preview deployed under an explicit name before the working and stable names were fixed may hold one of them.
  const holder =
    kind === "preview"
      ? undefined
      : targets.find(
          (t) => t.projectId === project.id && t.id !== id && t.name === name,
        );
  if (holder)
    throw new RigError(
      "TARGET_NAME",
      `Target name '${name}' already belongs to a Preview of this Project.`,
      `Destroy that Preview first: rig down preview --deployment ${name} --destroy.`,
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
  const settings = patchedSettings(config, kind);
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
  // Chosen against the Targets recorded now and the ports Operations running beside this one have claimed.
  const choose = async (reserved: ReadonlyMap<number, PortOwner>) =>
    await deps.files.selectPorts({
      requests: requests.filter((r) => !prior[r.name]),
      occupied: new Map([
        ...reserved,
        ...portOwners((await deps.store.read()).targets, id),
      ]),
      policy: kind === "preview" ? "dynamic" : "configured",
    });
  const selected = deps.ports
    ? await deps.ports.reserve({ target: name, project: project.name }, choose)
    : await choose(new Map());
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
    ...(kind !== "working"
      ? { sourceRoot: join(base, "revisions") }
      : {
          configRevision: document.revision,
          configDigest: configDigest(document.config),
        }),
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
