import type { DeploymentRecord, RuntimeState, TargetRecord } from "./runtime";

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
 * The stable Target is never destroyed, so its deploys are all its own. A Preview's are its own back from the newest while
 * each ended no earlier than the Preview was created and no later than the deploy after it: a destroyed Preview's deploys
 * ended before its replacement was created, and a clock set back shows as a deploy ending later than the next one. Going
 * back stops at either, or at a deploy of another Target, so what cannot be told stays with no Target at all. */
function ownersBeforeIds(
  records: readonly DeploymentRecord[],
  targets: readonly Pick<TargetRecord, "id" | "kind" | "name" | "createdAt">[],
): Map<DeploymentRecord, string> {
  const owners = new Map<DeploymentRecord, string>();
  for (const target of targets) {
    if (target.kind === "working") continue;
    const created = Date.parse(target.createdAt);
    let next = Infinity;
    for (const record of records.toReversed()) {
      if (record.kind !== target.kind || record.target !== target.name)
        continue;
      const ended = Date.parse(record.finishedAt);
      if (
        target.kind === "preview" &&
        (!(ended >= created && ended <= next) ||
          (record.targetId !== undefined && record.targetId !== target.id))
      )
        break;
      next = ended;
      if (record.targetId === undefined) owners.set(record, target.id);
    }
  }
  return owners;
}
/** Pure: a Project's deploys, oldest first, at most `lines` of the newest. `targets` are the Project's Targets now, whose
 * deploys recorded before Rig kept Target ids are reported with their id where that can be told. */
export function deploymentHistory(
  records: readonly DeploymentRecord[] | undefined,
  projectId: string,
  lines = 100,
  targets: readonly Pick<
    TargetRecord,
    "id" | "kind" | "name" | "createdAt"
  >[] = [],
): DeploymentReport[] {
  const own = (records ?? []).filter(
    (record) => record.projectId === projectId,
  );
  const owners = ownersBeforeIds(own, targets);
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
