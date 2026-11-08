import type { RuntimeCommand } from "../daemon/protocol";
import { RigError, asRigError } from "../domain/errors";
import { rigCommand } from "../domain/rig-command";
import type { TargetRecord } from "../domain/runtime";
import type { CommandContext, SelectedTarget } from "./command-execution";
import {
  assertDeploymentRecovered,
  deployCandidate,
  watchWarnings,
} from "./deploy";
import { describeServices, type KeepDecision } from "./keep-decision";
import { assertSourceBuildsKnown } from "./preparation-evidence";
import type { OperationCoordinator } from "./operation-coordinator";
import { targetScope } from "./operation-locks";
import type { OrphanSweep } from "./orphan-routes";
import { plannedSites } from "./ports";
import { destroyReplacedPreviews, previewsToReplace } from "./previews";
import { releaseUnreferencedRevisions } from "./revisions";
import { servedPhrase } from "./served";
import { deployTargetError } from "./target-refusals";
import { assertNewPreviewName, planTarget } from "./targets";

/** `rig deploy`: deploys a Commit of a Branch to the stable Target or a Preview, under its lease and those of the Previews
 * a new one replaces at the limit. A source the Target already runs completely is unchanged; a candidate that served and
 * was undone says so in its failure. */
export async function deployCommand(
  command: RuntimeCommand,
  { kind, name, selection }: SelectedTarget,
  context: CommandContext,
  capabilities: {
    sweep: OrphanSweep;
    previews: OperationCoordinator["previews"];
  },
): Promise<unknown> {
  const { operationId, deps, outcome } = context;
  const project = outcome.project!;
  let target = outcome.target;
  if (kind === "working") throw deployTargetError(project.name);
  if (command.targetId !== undefined && target?.id !== command.targetId)
    throw new RigError(
      "TARGET_REPLACED",
      `${name} is not the Target this deploy was asked for: it was destroyed${target ? " and made again" : ""} since.`,
      "Nothing was deployed. Reload the page and choose from the Target as it is now.",
      { target: name },
    );
  const document = selection.document!;
  const branch =
    command.branch ??
    (kind === "stable"
      ? (document.config.production_branch ??
        (await deps.documents.host()).deploy.production_branch)
      : await deps.sources.currentBranch(selection.checkout));
  outcome.attempted = true;
  outcome.deploySource = {
    branch,
    ...(target?.commit ? { previousCommit: target.commit } : {}),
    startedAt: deps.now(),
  };
  const preflight = await deps.sources.preflight({
    repoPath: project.repoPath,
    branch,
    productionBranch:
      document.config.production_branch ??
      (await deps.documents.host()).deploy.production_branch,
  });
  const commit = command.commit
    ? await deps.sources.resolve(project.repoPath, command.commit, project.id)
    : preflight.commit;
  outcome.deploySource = { ...outcome.deploySource, commit };
  assertDeploymentRecovered(target);
  const previous = target?.commit ? { previousCommit: target.commit } : {};
  // An uncertain attempt of this source is neither a completed no-op nor an ordinary retry of an incomplete deployment.
  if (target && !command.force)
    assertSourceBuildsKnown(target, { branch, commit });
  if (
    target?.commit === commit &&
    target.branch === branch &&
    !target.deploymentIncomplete &&
    !command.force
  )
    return await outcome.finish("unchanged", {
      warnings: preflight.warnings,
      ...previous,
    });
  const replacements =
    kind === "preview" && !target
      ? await claimPreviewSlot(name, context, capabilities.previews)
      : [];
  const candidate = await planTarget(
    {
      command: { ...command, branch },
      commit,
      kind,
      project,
      document,
      existing: target,
    },
    deps,
  );
  const wasRunning = target?.desired === "running";
  const revisions = [...(target ? [target] : []), candidate];
  let decision: KeepDecision;
  try {
    // A route block no recorded Target owns (#336) never holds a hostname from this deploy.
    const previous = target;
    const repository = project.repoPath;
    const deployed = await capabilities.sweep.before(candidate, () =>
      deployCandidate(
        candidate,
        previous,
        {
          activation: command.noUp ? "prepare" : "start",
          operationId,
          ...(command.force ? { force: true } : {}),
          repository,
          receipt: outcome.deployReceipt,
        },
        deps,
      ),
    );
    target = outcome.target = deployed.target;
    decision = deployed.decision;
  } catch (error) {
    // A rejected candidate's checkout is reclaimed; the deployment failure stays the outcome.
    for (const retained of await releaseUnreferencedRevisions(revisions, deps))
      await deps
        .diagnostic({
          operationId,
          action: command.action,
          outcome: "revision-retained",
          project: project.name,
          target: candidate.name,
          ...retained.causes,
        })
        .catch(() => {});
    // A candidate that served says so, and for how long, whatever undid it: Activity as the error.
    const served = outcome.deployReceipt.served;
    if (!served) throw error;
    outcome.note = servedPhrase(candidate.commit, served);
    const failure = asRigError(error);
    throw new RigError(
      failure.code,
      `${failure.message} The ${outcome.note}.`,
      failure.hint,
      failure.details,
      failure.causes,
    );
  }
  const warnings = [
    ...preflight.warnings,
    ...(command.noUp ? [preparedWarning(target, wasRunning)] : []),
    ...(await watchWarnings(target, project.repoPath, deps)),
    ...(await releaseUnreferencedRevisions(revisions, deps)).map(
      (retained) => retained.warning,
    ),
  ];
  const replaced = await destroyReplacedPreviews(
    replacements,
    project,
    operationId,
    deps,
  );
  warnings.push(...replaced.warnings);
  outcome.deployKept = decision.kept;
  // --no-up starts nothing, so it has no restart to explain; its warning says what stopped.
  const services = command.noUp ? undefined : describeServices(decision);
  outcome.note = services;
  return await outcome.finish("deployed", {
    warnings,
    retired: replaced.retired,
    ...(target.plan.domain ? { route: target.plan.domain } : {}),
    ...(plannedSites(target.plan).length
      ? {
          hostnames: plannedSites(target.plan).map((site) => site.hostname),
        }
      : {}),
    ...previous,
    kept: decision.kept,
    restarted: decision.restarted,
    ...(services ? { services } : {}),
  });
}
/** Counts a new Preview against its Project's limit and returns the Previews that must leave to
 * make room. The count and the claim happen with nothing awaited between them, so two deploys
 * of new Previews always see each other. A replacement chosen now that this command did not
 * take before it was admitted sends it back to select again. */
async function claimPreviewSlot(
  name: string,
  { operationId, admission, deps, outcome }: CommandContext,
  previews: OperationCoordinator["previews"],
): Promise<TargetRecord[]> {
  const project = outcome.project!;
  const policy = (await deps.documents.host()).deploy.previews;
  // Claims are read after the state, so a deploy that failed meanwhile is not counted and no Preview is destroyed for
  // it. A claim that ended during the read may belong to a deploy that recorded its Preview after the read began, so
  // the state is read again until no claim ended across the read: every deploy is then counted by its record or its
  // claim.
  let recorded: TargetRecord[];
  for (;;) {
    const ended = previews.endedPreviewClaims(project.id);
    recorded = (await deps.store.read()).targets.filter(
      (t) => t.projectId === project.id,
    );
    if (previews.endedPreviewClaims(project.id) === ended) break;
  }
  // Its scope is held, and every name that differs only in case shares it, so no case variant is created meanwhile.
  assertNewPreviewName(name, [
    ...recorded.filter((t) => t.kind === "preview").map((t) => t.name),
    ...previews.claimedPreviews(project.id, operationId),
  ]);
  const replacements = previewsToReplace(
    recorded,
    previews.claimedPreviews(project.id, operationId),
    policy,
  );
  if (
    !admission.holds(
      replacements.map((replacement) => targetScope(project.id, replacement)),
    )
  )
    throw admission.moved();
  previews.claimPreview(operationId, project.id, name);
  return replacements;
}
/** A --no-up deploy leaves nothing serving; the warning carries the exact command that starts the new deployment. */
function preparedWarning(
  target: Pick<TargetRecord, "name" | "kind" | "branch" | "plan">,
  wasRunning: boolean,
): string {
  const up = rigCommand("up", { target });
  return wasRunning
    ? `${target.name} was running and is now stopped on the new deployment. Run ${up} to start it.`
    : `${target.name} is deployed but stopped. Run ${up} to start it.`;
}
