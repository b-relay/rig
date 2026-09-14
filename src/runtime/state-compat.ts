import { join, relative, resolve, sep } from "node:path";
import type { RuntimeState, TargetRecord } from "../domain/runtime";
/** Deployed Targets recorded before `sourceRoot` existed are given the revisions directory of their
 * Target root when their workspace already sits inside it; any other record is returned unchanged. */
export function backfillSourceRoots(state: RuntimeState, root: string): RuntimeState {
  return {
    ...state,
    targets: state.targets.map((target) => backfillSourceRoot(target, root)),
  };
}
function backfillSourceRoot(target: TargetRecord, root: string): TargetRecord {
  if (target.kind === "local" || target.sourceRoot) return target;
  const revisions = join(resolve(root), "targets", target.projectId, target.id, "revisions");
  return within(revisions, resolve(target.plan.workspacePath))
    ? { ...target, sourceRoot: revisions }
    : target;
}
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}
