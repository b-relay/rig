import type { TargetRecord } from "../domain/runtime";
import {
  RigError,
  diagnosticCauses,
  diagnosticErrorCode,
  failureCauses,
  failureReason,
} from "../domain/errors";
import { rigCommand, type RecordedTarget } from "../domain/rig-command";
import { shellWord } from "../domain/target-selector";
import { routeOwnerToken } from "../domain/proxy-publication";
import type { RuntimeDependencies } from "./contracts";
import { plannedSites } from "./ports";

/** What withdrawing route blocks no recorded Target owns needs: the router, the state, the diagnostic log. */
type SweepDependencies = Pick<
  RuntimeDependencies,
  "lifecycle" | "store" | "diagnostic" | "id" | "root"
>;
/** The automatic sweep of route blocks whose Target no state record names (#336). */
export interface OrphanSweep {
  /** `withdrawOrphanedRoutes` confined to the Rig root, so a route file whose real path lies outside it (where another root
   * may own its blocks) is left to `rig proxy reload`. Never rejects: a failure is recorded and returned as `failure`, so
   * an Operation that then meets the orphan can say why it is still there. No Target is held: the router reads the
   * recorded Targets inside its own queue, after every route change queued before the sweep, and every Target is recorded
   * before its route is published. */
  sweep(): Promise<{ withdrawn: string[]; failure?: unknown }>;
  /** Runs `publish`, an Operation step that publishes `target`'s route, after the sweep; a ROUTE_CONFLICT it then meets
   * against a route no recorded Target owns is said as such (`orphanConflict`), with the sweep's failure. */
  before<T>(
    target: Pick<TargetRecord, "plan">,
    publish: () => Promise<T>,
  ): Promise<T>;
}
export function createOrphanSweep(deps: SweepDependencies): OrphanSweep {
  async function sweep(): Promise<{ withdrawn: string[]; failure?: unknown }> {
    const operationId = deps.id();
    try {
      return {
        withdrawn: await withdrawOrphanedRoutes(deps, true, operationId),
      };
    } catch (failure) {
      await deps
        .diagnostic({
          operationId,
          action: "reconcile",
          outcome: "route-orphans-failed",
          errorCode: diagnosticErrorCode(failure),
          ...diagnosticCauses(failure),
        })
        .catch(() => {});
      return { withdrawn: [], failure };
    }
  }
  return {
    sweep,
    async before(target, publish) {
      if (!plannedSites(target.plan).length) return await publish();
      const swept = await sweep();
      try {
        return await publish();
      } catch (error) {
        throw await orphanConflict(error, deps, swept.failure);
      }
    },
  };
}
/** Withdraws every route block whose Target no state record names (one an earlier `rig forget` left, #336, or a state that
 * lost a Target), so it no longer holds its hostnames from a new owner. The owners are read inside the router's queue.
 * `confined` (the automatic sweep) withdraws nothing unless the route file really lies inside the Rig root, checked by
 * the router where it reads and writes. Records that it withdrew some and resolves with their hostnames; fails as the
 * route change fails. */
export async function withdrawOrphanedRoutes(
  deps: SweepDependencies,
  confined: boolean,
  operationId = deps.id(),
): Promise<string[]> {
  const withdrawn = await deps.lifecycle.pruneRoutes(
    async () =>
      new Set((await deps.store.read()).targets.map((target) => target.id)),
    confined ? { within: deps.root } : undefined,
  );
  // Hostnames come from config, which diagnostics never carry: the entry says how many were withdrawn.
  if (withdrawn.length)
    await deps
      .diagnostic({
        operationId,
        action: "reconcile",
        outcome: "route-orphans-withdrawn",
        reason: `${withdrawn.length} hostname${withdrawn.length === 1 ? "" : "s"} no recorded Target owned`,
      })
      .catch(() => {});
  return withdrawn;
}
/** `error` said for what it is when it is a ROUTE_CONFLICT against route blocks: against one no recorded Target owns, no
 * `rig down` reaches that owner, so the hint names doctor and the reload that withdraws it, and `sweepFailure`, why the
 * sweep before the Operation could not, is kept as the recovery cause and in the message; against recorded Targets only,
 * the hint names each of them and the commands that free the hostname from it (`hostnameRelease`). Any other error is
 * returned as it is. */
async function orphanConflict(
  error: unknown,
  deps: Pick<RuntimeDependencies, "store">,
  sweepFailure?: unknown,
): Promise<unknown> {
  if (!(error instanceof RigError) || error.code !== "ROUTE_CONFLICT")
    return error;
  const tokens = error.details.routeTokens;
  if (!Array.isArray(tokens) || !tokens.length) return error;
  const state = await deps.store.read().catch(() => undefined);
  if (!state) return error;
  const recorded = new Set(
    state.targets.map((target) => routeOwnerToken(target.id)),
  );
  if (!tokens.some((token) => !recorded.has(String(token)))) {
    const holders = state.targets
      .filter((target) => tokens.includes(routeOwnerToken(target.id)))
      .map(hostnameRelease);
    // An owner that is no Target, such as proxy.routes in Host config.
    const setting = (
      Array.isArray(error.details.owners) ? error.details.owners : []
    )
      .map(String)
      .find((owner) => !owner.startsWith("the Target route "));
    return new RigError(
      error.code,
      error.message,
      `Each hostname has one owner, and a stopped Target keeps its own. To free it from ${holders.join("; or from ")}${setting ? `; or take it out of ${setting} and run rig proxy reload` : ""}. Nothing changed.`,
      error.details,
      error.causes,
    );
  }
  const hostname = String(error.details.hostname ?? "This hostname");
  return new RigError(
    "ROUTE_CONFLICT",
    `${hostname} is held by a route whose Target no longer exists${
      sweepFailure === undefined
        ? ""
        : `, and Rig could not withdraw it: ${failureReason(sweepFailure)}`
    }${sweepFailure === undefined ? "." : ""}`,
    "No Target serves it any more: run rig doctor (route-owners) and rig proxy reload, then retry.",
    {
      ...error.details,
      ...(sweepFailure instanceof RigError
        ? { withdrawal: sweepFailure.code }
        : {}),
    },
    sweepFailure === undefined
      ? error.causes
      : failureCauses(error, sweepFailure),
  );
}
/** Who `target` is and what frees the hostnames it holds, for a ROUTE_CONFLICT hint: stopping it keeps its route, so only
 * its domain changed and applied, its destruction for a Preview, or its Project forgotten gives them up. Forget refuses
 * while any Preview of the Project remains, so it is offered with that, and not for a Preview, which its destroy frees. */
export function hostnameRelease(target: RecordedTarget): string {
  const project = target.plan.project;
  if (target.kind === "preview")
    return `the Preview ${target.name} of ${project}, run ${rigCommand("down", { target }, "--destroy")}, which deletes its data`;
  const release =
    target.kind === "working"
      ? `change its domain in rig.yaml and run ${rigCommand("restart", { target })}`
      : `commit a changed domain in rig.yaml and run ${rigCommand("deploy", { target })}`;
  return `the ${target.kind} Target of ${project}, ${release}, or stop every Target of ${project}, destroy its Previews (which deletes their data), then run rig forget ${shellWord(project)}`;
}
