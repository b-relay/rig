import type { Failure } from "./outcome";
import { isCommand } from "./pulse";
import { resolveSettlement } from "./reconcile";
import type { ActivityResult, OperationResult, QueueResult } from "./types";

type Recorded = ActivityResult["operations"][number];

/** What rigd is doing to one Target and how its last action ended, read back from rigd so a reload loses neither. */
export interface TargetWork {
  /** The command rigd is running on it now, whoever asked. */
  running?: { operationId: string; action: string; phase: string };
  /** The newest of its lifecycle actions Activity recorded. */
  last?: Recorded;
}
/** Each Target's work, by its name. */
export type ProjectWork = Partial<Record<string, TargetWork>>;

/** The actions a Target's controls send; a crash, a job run or an automatic restart is not the outcome of one. */
const LIFECYCLE = new Set(["up", "restart", "down", "deploy", "destroy"]);

/** Pure: each Target's work from rigd's queue and the Project's Activity. Either read may have failed, which says nothing
 * of the work: the page then offers what status says, and rigd queues or refuses what it is asked. */
export function projectWork(
  project: string,
  queue: Pick<QueueResult, "operations"> | undefined,
  activity: Pick<ActivityResult, "operations"> | undefined,
): ProjectWork {
  const work: ProjectWork = {};
  for (const record of activity?.operations ?? []) {
    if (!record.target || record.component || !LIFECYCLE.has(record.action))
      continue;
    const last = work[record.target]?.last;
    if (!last || record.occurredAt >= last.occurredAt)
      work[record.target] = { last: record };
  }
  for (const operation of queue?.operations ?? []) {
    if (
      operation.project !== project ||
      !operation.target ||
      !isCommand(operation)
    )
      continue;
    work[operation.target] = {
      ...work[operation.target],
      running: {
        operationId: operation.operationId,
        action: operation.action,
        phase: operation.phase,
      },
    };
  }
  return work;
}
/** Pure: a recorded action's failure, as a lost reply is reported from the same record; undefined unless it failed. */
export function recordedFailure(last: Recorded): Failure | undefined {
  const resolved = resolveSettlement(
    {
      state: "finished",
      outcome: last.outcome,
      occurredAt: last.occurredAt,
      ...(last.message ? { message: last.message } : {}),
    },
    { operationId: last.id, action: last.action },
    "",
  );
  return resolved && !resolved.ok ? resolved.failure : undefined;
}
/** Pure: a recorded action as one line, plainly from before this page: `Last action: started`, or
 * `Last action: restart failed: BUILD_FAILED`. */
export function lastActionText(
  last: Pick<Recorded, "action" | "outcome" | "message">,
): string {
  return last.outcome === "failed"
    ? `Last action: ${last.action} failed${last.message ? `: ${last.message}` : ""}`
    : `Last action: ${last.outcome}`;
}
/** Pure: what a command that removed something left, for the page it lands on, from the Activity record of the Operation
 * the link names; undefined for any other record, so the link alone never claims anything. `project` is the Project whose
 * page it is. */
export function completedNotice(
  operations: readonly Recorded[],
  operation: string,
  project: string | undefined,
): (Pick<OperationResult, "operationId"> & { text: string }) | undefined {
  const record = operations.findLast((each) => each.id === operation);
  if (!record || record.outcome === "failed") return undefined;
  if (project !== undefined && record.project !== project) return undefined;
  if (record.action === "destroy" && record.target)
    return {
      operationId: record.id,
      text: `Preview ${record.target} was destroyed.`,
    };
  if (record.action === "forget" && record.project)
    return {
      operationId: record.id,
      text: `Project ${record.project} was forgotten: this Host no longer manages it. Its repository is untouched.`,
    };
  return undefined;
}
