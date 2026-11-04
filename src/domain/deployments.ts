import type {
  DeploymentRecord,
  OperationRecord,
  RuntimeState,
  TargetRecord,
} from "./runtime";

/** How many deploys state.json keeps across every Project; the oldest are dropped beyond it. A deploy is also
 * an Operation in Activity, which keeps its own count. */
export const DEPLOYMENTS_RETAINED = 500;

/** Appends one finished deploy and drops the oldest beyond the retained count, so state.json stays bounded. */
export function recordDeployment(
  state: RuntimeState,
  record: DeploymentRecord,
): void {
  const history = (state.deployments ??= []);
  history.push(record);
  if (history.length > DEPLOYMENTS_RETAINED)
    history.splice(0, history.length - DEPLOYMENTS_RETAINED);
}
/** One deploy as the control plane reports it: the recorded fields without the internal Project id, with how long it took. */
export type DeploymentReport = Omit<DeploymentRecord, "projectId"> & {
  /** Milliseconds from the start of the deploy to its outcome. */
  durationMs: number;
};
/** Pure: which Target each deploy recorded before Rig kept Target ids was of, of `records`, oldest first, in one Project.
 * The stable Target is never destroyed, so its deploys are all its own. A Preview's are told only from what no clock can
 * fool. Going back from the Commit it runs now, each deploy must have put in place the Commit the next one replaced, and
 * the first deploy of a Preview replaced nothing, so going back ends there. It also ends at a destroy of that name, by
 * Activity's order: what came before it was an earlier Preview's. Whatever cannot be told stays with no Target. */
function ownersBeforeIds(
  records: readonly DeploymentRecord[],
  targets: readonly Pick<
    TargetRecord,
    "id" | "kind" | "name" | "projectId" | "commit"
  >[],
  activity: readonly Pick<
    OperationRecord,
    "id" | "action" | "target" | "projectId"
  >[],
): Map<DeploymentRecord, string> {
  const owners = new Map<DeploymentRecord, string>();
  const position = new Map(activity.map((entry, index) => [entry.id, index]));
  for (const target of targets) {
    if (target.kind === "working") continue;
    const destroyed = activity.findLastIndex(
      (entry) =>
        entry.action === "destroy" &&
        entry.projectId === target.projectId &&
        entry.target === target.name,
    );
    let expected = target.commit;
    for (const record of records.toReversed()) {
      if (record.kind !== target.kind || record.target !== target.name)
        continue;
      if (target.kind === "stable") {
        if (record.targetId === undefined) owners.set(record, target.id);
        continue;
      }
      if (
        (record.targetId !== undefined && record.targetId !== target.id) ||
        (destroyed >= 0 && (position.get(record.id) ?? -1) < destroyed) ||
        (record.outcome !== "failed" && record.commit !== expected)
      )
        break;
      if (record.targetId === undefined) owners.set(record, target.id);
      if (record.previousCommit === undefined) break;
      expected = record.previousCommit;
    }
  }
  return owners;
}
/** Pure: a Project's deploys, oldest first, at most `lines` of the newest. `targets` are the Project's Targets now, whose
 * deploys recorded before Rig kept Target ids are reported with their id where that can be told; `activity` is Activity in
 * the order it was recorded. */
export function deploymentHistory(
  records: readonly DeploymentRecord[] | undefined,
  projectId: string,
  lines = 100,
  targets: Parameters<typeof ownersBeforeIds>[1] = [],
  activity: Parameters<typeof ownersBeforeIds>[2] = [],
): DeploymentReport[] {
  const own = (records ?? []).filter(
    (record) => record.projectId === projectId,
  );
  const owners = ownersBeforeIds(own, targets, activity);
  return own
    .slice(-lines)
    .map((entry) => ({ entry, targetId: owners.get(entry) }))
    .map(({ entry: { projectId: _id, ...record }, targetId }) => ({
      ...record,
      ...(targetId ? { targetId } : {}),
      durationMs: Math.max(
        0,
        Date.parse(record.finishedAt) - Date.parse(record.startedAt),
      ),
    }));
}
