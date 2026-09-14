import type { OperationRecord, RuntimeState } from "./runtime";

/** How many final Operations state.json keeps. Every Operation is also written to the
 * diagnostic log, which has its own retention, so older activity is not lost, only unlisted. */
export const ACTIVITY_RETAINED = 1000;

/** Appends one final Operation and drops the oldest beyond the retained count, so
 * state.json stays bounded however long the Host runs. */
export function recordActivity(
  state: RuntimeState,
  record: OperationRecord,
): void {
  state.activity.push(record);
  if (state.activity.length > ACTIVITY_RETAINED)
    state.activity.splice(0, state.activity.length - ACTIVITY_RETAINED);
}
