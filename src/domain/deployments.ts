import type { DeploymentRecord, RuntimeState } from "./runtime";

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
/** Pure: a Project's deploys, oldest first, at most `lines` of the newest. */
export function deploymentHistory(
  records: readonly DeploymentRecord[] | undefined,
  projectId: string,
  lines = 100,
): DeploymentReport[] {
  return (records ?? [])
    .filter((record) => record.projectId === projectId)
    .slice(-lines)
    .map(({ projectId: _id, ...record }) => ({
      ...record,
      durationMs: Math.max(
        0,
        Date.parse(record.finishedAt) - Date.parse(record.startedAt),
      ),
    }));
}
