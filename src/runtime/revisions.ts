import type { ManagedComponent } from "../config/types";
import {
  failureCauses,
  failureReason,
  type FailureCauses,
} from "../domain/errors";
import { within } from "../domain/paths";
import type {
  HeldCheckout,
  RuntimeState,
  TargetRecord,
} from "../domain/runtime";
import { boundedObservations } from "./bounded-observations";
import type { RuntimeDependencies } from "./contracts";
import { holdCheckout } from "./jobs";

/* A deployed Target's checkouts (`<target>/revisions/<id>`) are given back once nothing runs from them: no plan or recovery
 * plan, no job run in progress (ADR 0013) and no Service process a deploy kept running (ADR 0016). One something still
 * runs in is held, recorded in `heldCheckouts`, and offered back every 30 seconds until it is gone. */

/** What giving back revisions needs: the mirror, the state, and a bounded look at the Services' processes. */
export type RevisionDependencies = Pick<
  RuntimeDependencies,
  | "sources"
  | "store"
  | "observations"
  | "observationBudgetMs"
  | "observationDeadline"
>;

/** The checkout a deployed Target owns under its revisions directory; the working Target has none. */
export function ownedRevision(record: TargetRecord): string | undefined {
  return record.sourceRoot &&
    within(record.sourceRoot, record.plan.workspacePath)
    ? record.plan.workspacePath
    : undefined;
}
/** A revision that stayed on disk after a deployment decision, with the reason for the user and the diagnostic log. */
export interface RetainedRevision {
  readonly workspacePath: string;
  readonly warning: string;
  readonly causes: FailureCauses;
}
/** How giving back one revision went: given back, still a plan's or recovery plan's checkout, still run in by a job run
 * or a Service process (held), or not removed. */
export type RevisionRelease =
  | {
      readonly workspacePath: string;
      readonly outcome: "released" | "planned" | "held";
    }
  | (RetainedRevision & { readonly outcome: "failed" });

/** Gives back each revision among `records` that nothing runs from any more, once a deployment outcome is saved, and
 * records each one a job run or a Service process still runs in as held, in one write, for the sweep to give back later.
 * Resolves the revisions that could not be removed; each failure is reported, never thrown: the outcome stands and the
 * checkout stays. */
export async function releaseUnreferencedRevisions(
  records: readonly TargetRecord[],
  deps: RevisionDependencies,
): Promise<RetainedRevision[]> {
  const results = await releaseRevisions(records, deps);
  const held = records.flatMap((record): HeldCheckout[] => {
    const workspace = ownedRevision(record);
    return workspace !== undefined &&
      results.some(
        (result) =>
          result.workspacePath === workspace && result.outcome === "held",
      )
      ? [{ target: record.id, project: record.projectId, workspace }]
      : [];
  });
  if (held.length)
    await deps.store.update((state) => {
      for (const checkout of held) holdCheckout(state, checkout);
    });
  return results.flatMap((result) =>
    result.outcome === "failed" ? [result] : [],
  );
}

/** Gives back each revision among `records` that no plan, recovery plan, job run in progress or Service process runs
 * from, and says how each went. A Service process holds the checkout its run's `source` names while it is observed
 * running under that run's incarnation, or cannot be observed within the status budget: Rig cannot prove it gone. */
export async function releaseRevisions(
  records: readonly TargetRecord[],
  deps: RevisionDependencies,
): Promise<RevisionRelease[]> {
  const state = await deps.store.read();
  const planned = new Set(
    state.targets.flatMap((record) => [
      record.plan.workspacePath,
      ...(record.recovery ? [record.recovery.plan.workspacePath] : []),
    ]),
  );
  // A job run keeps the checkout it started in until it ends, so a deploy never removes it from under the run.
  const running = new Set(
    (state.jobs ?? []).flatMap((record) =>
      record.running?.workspace ? [record.running.workspace] : [],
    ),
  );
  const results: RevisionRelease[] = [];
  for (const record of records) {
    const workspacePath = ownedRevision(record);
    if (
      !workspacePath ||
      results.some((result) => result.workspacePath === workspacePath)
    )
      continue;
    if (planned.has(workspacePath)) {
      results.push({ workspacePath, outcome: "planned" });
      continue;
    }
    if (
      running.has(workspacePath) ||
      (await runInByService(state, workspacePath, deps))
    ) {
      results.push({ workspacePath, outcome: "held" });
      continue;
    }
    try {
      await deps.sources.release({ project: record.projectId, workspacePath });
      results.push({ workspacePath, outcome: "released" });
    } catch (error) {
      results.push({
        workspacePath,
        outcome: "failed",
        warning: `Revision ${workspacePath} was not removed: ${failureReason(error)} Delete it by hand to reclaim disk.`,
        causes: failureCauses(error),
      });
    }
  }
  return results;
}

/** Whether a Service process may still run in `checkout`: a run whose source names it, whose process is observed running
 * under the run's incarnation (or one that names none), or cannot be observed. */
async function runInByService(
  state: Pick<RuntimeState, "targets">,
  checkout: string,
  deps: Pick<
    RevisionDependencies,
    "observations" | "observationBudgetMs" | "observationDeadline"
  >,
): Promise<boolean> {
  const runs = state.targets.flatMap((target) =>
    Object.entries(target.services ?? {}).flatMap(([service, run]) => {
      const component = target.plan.components.find(
        (candidate): candidate is ManagedComponent =>
          candidate.kind === "managed" && candidate.name === service,
      );
      // A Service its plan no longer has was stopped by the deploy that dropped it; no record of it is kept.
      return run.source?.checkout === checkout && component
        ? [{ target, component, incarnation: run.incarnation }]
        : [];
    }),
  );
  if (!runs.length) return false;
  const observed = await boundedObservations(
    runs.map(
      ({ target, component }) =>
        (signal: AbortSignal) =>
          deps.observations.process(target, component, signal),
    ),
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  return observed.some((result, index) => {
    if (result.kind !== "completed") return true;
    const process = result.value;
    if (process.state === "unknown") return true;
    return (
      process.state === "running" &&
      (process.incarnation === undefined ||
        process.incarnation === runs[index]!.incarnation)
    );
  });
}
