import type { RuntimeCommand } from "../daemon/protocol";
import type { TargetRecord } from "../domain/runtime";
import type { CommandContext } from "./command-execution";
import {
  configScope,
  projectScope,
  registrationScope,
} from "./operation-locks";
import {
  prepareRegistration,
  registerProject,
  selectProject,
} from "./projects";
import { forgetProject, updateRegistration } from "./registration";

/* The commands that change a Project's registration. `init` of a registered Project writes at most its rig.yaml, as a
 * config edit does, so it takes the Project's config scope; the others take the whole Project, refused at once while a
 * Target of it runs or is in a transition (ADR 0007). */

/** `rig init`: registers the Project in `command.repoPath`, or initializes a registered one again. */
export async function initProject(
  command: RuntimeCommand,
  { admission, deps, outcome }: CommandContext,
): Promise<unknown> {
  const identity = await prepareRegistration(command, deps);
  // Initializing a registered Project again writes at most its rig.yaml, as a config edit does, which is not a
  // Target's. So it takes the Project's config scope and
  // never waits for (or holds the Project's other Targets behind) a Target's stop. A new Project takes only its name.
  const registered = (await deps.store.read()).projects.find(
    (p) => p.name === identity.name && p.repoPath === identity.repoPath,
  );
  await admission.admit(
    [
      registered
        ? configScope(registered.id)
        : registrationScope(identity.name),
    ],
    { project: identity.name },
  );
  outcome.attempted = true;
  const initialized = await registerProject(command, identity, deps);
  outcome.project = initialized.project;
  const kept = identity.configPath ? unappliedInitFlags(command) : [];
  return await outcome.finish("registered", {
    path: outcome.project.configPath,
    ...(kept.length
      ? {
          warnings: [
            `The existing config at ${identity.configPath} was kept; ${listed(kept)} ${kept.length === 1 ? "was" : "were"} not applied. Edit the config to change it.`,
          ],
        }
      : {}),
  });
}
/** `rig forget`: removes the Project's registration and what Rig keeps for it. */
export async function forgetCommand(
  command: RuntimeCommand,
  context: CommandContext,
): Promise<unknown> {
  const { deps, outcome } = context;
  outcome.project = (await selectProject(command, deps, false)).project;
  const selected = outcome.project;
  context.refuseActive(
    (await deps.store.read()).targets.filter(
      (t) => t.projectId === selected.id,
    ),
  );
  const targets = await context.enter([projectScope(selected.id)]);
  outcome.attempted = true;
  const warnings = await forgetProject(outcome.project, targets, deps);
  // Recorded as well as answered: the dashboard reads them back on the page a forget lands on.
  if (warnings.length) outcome.note = warnings.join(" ");
  return await outcome.finish("forgotten", warnings.length ? { warnings } : {});
}
/** `rig rename` and `rig repoint` of the selected Project, whose Targets are `targets` as recorded at selection. */
export async function updateProject(
  command: RuntimeCommand,
  targets: readonly TargetRecord[],
  context: CommandContext,
): Promise<unknown> {
  const { deps, outcome } = context;
  const selected = outcome.project!;
  if (command.action === "repoint" || command.newName !== selected.name)
    context.refuseActive(targets);
  const admitted = await context.enter([
    projectScope(selected.id),
    // A rename also takes its new name, so a registration of that name cannot race it.
    ...(command.action === "rename" && command.newName
      ? [registrationScope(command.newName)]
      : []),
  ]);
  outcome.attempted = true;
  const updated = await updateRegistration(
    command,
    outcome.project!,
    admitted,
    deps,
  );
  outcome.project = updated.project;
  return await outcome.finish(updated.outcome, {
    repoPath: updated.project.repoPath,
    ...(updated.warnings?.length ? { warnings: updated.warnings } : {}),
  });
}
/** The scaffold flags an init carried that an existing config keeps out. */
function unappliedInitFlags(command: RuntimeCommand): string[] {
  const flags: [keyof RuntimeCommand, string][] = [
    ["productionBranch", "--production-branch"],
    ["domain", "--domain"],
    ["service", "--service"],
    ["tool", "--tool"],
  ];
  return flags
    .filter(([field]) => command[field] !== undefined)
    .map(([, flag]) => flag);
}
function listed(items: string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
