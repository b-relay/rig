import type { UsageRetention } from "./usage-sampler";

/** When one kind of history maintenance runs, in milliseconds on the monotonic clock: `everyMs` after it succeeds and
 * `retryMs` after it fails. `first` says whether the first pass runs it or waits `everyMs` from then. */
export interface MaintenancePolicy {
  readonly everyMs: number;
  readonly retryMs: number;
  readonly first: "run" | "wait";
}

/** Where one kind of maintenance stands: when it is next due (absent before the first pass), and the error its last
 * attempt failed with (absent once an attempt succeeds). */
export interface MaintenanceState {
  readonly dueAt?: number;
  readonly failure?: unknown;
}

/** The outcome of one attempt. */
export type MaintenanceOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/** Pure: when maintenance in `state` is due, as of a pass at `at`. */
export function dueAt(
  policy: MaintenancePolicy,
  state: MaintenanceState,
  at: number,
): number {
  return state.dueAt ?? (policy.first === "run" ? at : at + policy.everyMs);
}

/** Pure: where maintenance stands after an attempt at `at`: due again a whole interval later on success, with no
 * failure; due again after the retry delay on failure, holding its error. */
export function attempted(
  policy: MaintenancePolicy,
  at: number,
  outcome: MaintenanceOutcome,
): MaintenanceState {
  return outcome.ok
    ? { dueAt: at + policy.everyMs }
    : { dueAt: at + policy.retryMs, failure: outcome.error };
}

/** Runs `work` when it is due at `at`, and returns where maintenance stands then. A failure of `work` is held in the
 * result, never thrown; maintenance not yet due keeps its failure. */
export async function maintained(
  policy: MaintenancePolicy,
  state: MaintenanceState,
  at: number,
  work: () => Promise<void>,
): Promise<MaintenanceState> {
  const due = dueAt(policy, state, at);
  if (at < due) return { ...state, dueAt: due };
  try {
    await work();
    return attempted(policy, at, { ok: true });
  } catch (error) {
    return attempted(policy, at, { ok: false, error });
  }
}

/** Pure: what a prune at `second` (Unix seconds) removes by `retention`: detail and history before these Unix seconds.
 * Never the seconds of a held minute (`heldMinutes`, Unix minutes): its write merges with them, and a store whose
 * minutes lose their seconds strictly oldest first can tell where detail starts. */
export function pruneBefore(input: {
  readonly second: number;
  readonly retention: UsageRetention;
  readonly heldMinutes: readonly number[];
}): { readonly detailBefore: number; readonly historyBefore: number } {
  const { second, retention } = input;
  return {
    detailBefore: Math.min(
      second - retention.detailHours * 3600,
      ...input.heldMinutes.map((minute) => minute * 60),
    ),
    historyBefore: second - retention.retentionDays * 86_400,
  };
}
