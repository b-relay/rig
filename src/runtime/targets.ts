import { join } from "node:path";
import { generatedPreviewName, shellWord } from "../domain/target-selector";
import type { RuntimeCommand } from "../daemon/protocol";
import type {
  ProjectRecord,
  TargetRecord,
  StateStore,
} from "../domain/runtime";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import { configDigest } from "../config/config-digest";
import { RigError } from "../domain/errors";
import {
  MAX_NAME_LENGTH,
  caseVariantOf,
  nameProblem,
  reservedPreviewName,
} from "../domain/names";
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
/** The reserved names no recorded Preview has in exactly this spelling, so a selector naming one is refused outright: they
 * were refused since Previews could be named, and state from before names were fixed is read with such a Preview renamed
 * (see state-store). Other spellings, and `all`, were reserved later: a Preview recorded under one stays selectable. */
const NEVER_HELD_PREVIEW_NAMES: readonly string[] = [
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
  return generatedPreviewName(command.branch);
}
/** Which Target a command's selector means: `working`, `stable`, or `preview` with a Branch or deployment name. No selector
 * means the working Target. The working and stable Targets are named by their role, so a recorded one is found by its kind.
 * Rejects TARGET_UNKNOWN for any other selector, and PREVIEW_NAME for a Preview named by a reserved name, which no Preview has:
 * state from before names were fixed is read with such a Preview renamed (see state-store). */
export function selectTarget(
  command: Pick<RuntimeCommand, "target" | "deployment" | "branch">,
): { kind: TargetKind; name: string } {
  if (command.target === PREVIEW_SELECTOR) {
    const name = previewName(command);
    if (NEVER_HELD_PREVIEW_NAMES.includes(name))
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
/** Whether `name` is one `project` had before a rename: config that names it is this Project's, from before the rename. */
export function formerName(
  project: Pick<ProjectRecord, "name" | "formerNames">,
  name: string,
): boolean {
  return name !== project.name && !!project.formerNames?.includes(name);
}
/** Refuses PREVIEW_NAME for a name no new Preview may take: one the name rule refuses, any spelling of a reserved name,
 * or a spelling of one of `taken`, the Project's other Previews, that differs only in case, since a Mac's disk would give
 * both one Tool path. A Preview recorded under such a name before these rules is only reported by doctor: it keeps working. */
export function assertNewPreviewName(
  name: string,
  taken: Iterable<string>,
): void {
  const problem = nameProblem(name);
  if (problem)
    throw new RigError(
      "PREVIEW_NAME",
      `The Preview name ${problem}.`,
      `Pass --deployment with a name of 1 to ${MAX_NAME_LENGTH} letters, digits, '_' or '-', starting with a letter or digit.`,
      { name },
    );
  const reserved = reservedPreviewName(name);
  if (reserved)
    throw new RigError(
      "PREVIEW_NAME",
      `'${name}' is reserved: ${reservedBecause(reserved)}${reserved === name ? "" : ", and a Mac's disk does not tell case apart"}.`,
      "Choose another Preview deployment name.",
      { name, reserved },
    );
  const variant = caseVariantOf(name, taken);
  if (variant !== undefined)
    throw new RigError(
      "PREVIEW_NAME",
      `This Project already has a Preview named '${variant}', which differs from '${name}' only in case: a Mac's disk does not tell them apart, so they would share Tool paths.`,
      `Deploy to it with --deployment ${variant}, or choose another name.`,
      { name, existing: variant },
    );
}
/** Why `reserved` is: what it names already. */
export function reservedBecause(reserved: string): string {
  if (reserved === WORKING_TOOL_SUFFIX)
    return "the working Target's Tools are published as <tool>-dev";
  if (reserved === "all")
    return "the dashboard's Monitor shows every Target together as all";
  return "it names this Project's working or stable Target";
}
/** Refuses TARGET_OFF when rig.yaml leaves the role off: a command that would select, start, deploy or publish an off Target
 * does nothing. The hint names the one line that turns it on. */
export function assertTargetOn(
  config: Pick<ProjectConfig, "targets">,
  role: TargetRole,
): void {
  if (targetOn(config, role)) return;
  throw new RigError(
    "TARGET_OFF",
    `${roleLabel(role)} off in rig.yaml.`,
    `${turnOnInstruction(config, role)}.`,
    { role },
  );
}
/** The role as the subject of a sentence: "Previews are", "The stable Target is". */
export function roleLabel(role: TargetRole): string {
  return role === "preview" ? "Previews are" : `The ${role} Target is`;
}
/** The one edit to rig.yaml that turns an off role on, without a closing period: change its `false` to `true`, or add the
 * key, which is the same line whether or not rig.yaml has a targets key yet. */
export function turnOnInstruction(
  config: Pick<ProjectConfig, "targets">,
  role: TargetRole,
): string {
  return config.targets?.[role] === false
    ? `Change \`${role}: false\` to \`${role}: true\` under targets in rig.yaml`
    : `Add \`${role}: true\` under targets in rig.yaml`;
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
/** `replanned` with each Tool still published under a name from before Target names were fixed (`publishedAs`) keeping that
 * name, for a plan that replaces `previous` without retiring its executables (a repoint). The file stays where it is and
 * known, so the next plan that does retire them (rig up of a stopped working Target, or rig restart) removes it. */
export function keepPublishedNames(
  previous: Pick<TargetRecord, "plan">,
  replanned: TargetRecord,
): TargetRecord {
  const published = new Map(
    previous.plan.components.flatMap((component) =>
      component.kind === "installed" && component.publishedAs
        ? [[component.name, component.publishedAs] as const]
        : [],
    ),
  );
  if (!published.size) return replanned;
  return {
    ...replanned,
    plan: {
      ...replanned.plan,
      components: replanned.plan.components.map((component) =>
        component.kind === "installed" && published.has(component.name)
          ? { ...component, publishedAs: published.get(component.name)! }
          : component,
      ),
    },
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
/** The rig config committed on a prepared revision, under the Project's name: a Commit from before a rename names a former
 * one and is still this Project's. A revision that names another Project is never deployed here. */
async function committedConfig(
  workspacePath: string,
  project: ProjectRecord,
  deps: Pick<RuntimeDependencies, "documents">,
): Promise<ProjectConfig> {
  const revision = await deps.documents.read(workspacePath);
  if (formerName(project, revision.config.name))
    return { ...revision.config, name: project.name };
  if (revision.config.name !== project.name)
    throw new RigError(
      "PROJECT_IDENTITY",
      `The deployed revision's rig config names Project '${revision.config.name}', not '${project.name}'.`,
      `Deploy a Commit whose rig config keeps this Project's name, or adopt the new one: rig rename ${shellWord(revision.config.name)} --project ${shellWord(project.name)}.`,
      { revisionPath: revision.path },
    );
  return revision.config;
}
