import { recordActivity } from "../domain/activity";
import { recordDeployment } from "../domain/deployments";
import {
  diagnosticCauses,
  diagnosticErrorCode,
  diagnosticEvidence,
  type FailureCauses,
} from "../domain/errors";
import type {
  OperationRecord,
  ProjectRecord,
  TargetRecord,
} from "../domain/runtime";
import type { RuntimeCommand } from "../daemon/protocol";
import { PREVIEW_SELECTOR } from "../config/schema";
import type { RuntimeDependencies } from "./contracts";
import type { ServedReceipt } from "./served";
import { killedMessage, type StopTracking } from "./stop-progress";

/** What a deploy set out to deploy, so its history names the source even when it fails before a Target records it. */
export interface DeploySource {
  branch: string;
  commit?: string;
  previousCommit?: string;
  /** When the deploy began its work, once its Target was free: time queued behind another Operation is not its duration. */
  startedAt: string;
}
/** What one command's Activity entry, deployment history and diagnostic say once it ends, gathered while it runs. Each
 * command family sets what it learns as it learns it, so a failure at any point is recorded with what was known then. */
export interface OperationOutcome {
  project?: ProjectRecord;
  target?: TargetRecord;
  /** The Target a command aimed at, so a failure before its record exists is still filed under its name. */
  aimed?: string;
  /** Set once selection and argument checks are done: a failure after this point is an Operation outcome and is
   * recorded in activity; one before it is a usage mistake and is not. */
  attempted: boolean;
  /** What the Operation acted on, for its Activity entry, such as the job and backup a restore put back. */
  note?: string;
  /** The Job a run or restore acted on, so its Activity entry is filed under it. */
  component?: OperationRecord["component"];
  deploySource?: DeploySource;
  /** The Services a deploy kept running (ADR 0016), for its history. */
  deployKept: readonly string[];
  /** What the deploy's candidate served (ADR 0020), for its history and Activity whatever the outcome. */
  readonly deployReceipt: ServedReceipt;
  /** Records `outcome` and answers the command with it and `extra`. */
  finish(
    outcome: OperationRecord["outcome"],
    extra?: Record<string, unknown>,
  ): Promise<unknown>;
  /** Records `error` as the Operation's failure once it was attempted, and as a rejection in the diagnostic log before.
   * Never rejects: no recording failure replaces the Operation's own. */
  recordFailure(error: unknown): Promise<void>;
}
/** The outcome of the mutation `operationId`, recorded through `deps`; `tracking` is what rigd lists for it. */
export function operationOutcome(
  command: RuntimeCommand,
  operationId: string,
  deps: Pick<RuntimeDependencies, "store" | "diagnostic" | "now">,
  tracking: () => StopTracking | undefined,
): OperationOutcome {
  const known: OperationOutcome = {
    attempted: false,
    deployKept: [],
    deployReceipt: {},
    finish,
    async recordFailure(error) {
      const errorCode = diagnosticErrorCode(error);
      const causes = diagnosticCauses(error);
      const providerEvidence = diagnosticEvidence(error);
      const evidence = {
        operationId,
        action: command.action,
        errorCode,
        ...causes,
        ...(providerEvidence ? { evidence: providerEvidence } : {}),
      };
      try {
        if (known.attempted)
          await record("failed", errorCode, causes, providerEvidence);
        else await deps.diagnostic({ ...evidence, outcome: "rejected" });
      } catch {
        try {
          await deps.diagnostic({ ...evidence, outcome: "failed" });
        } catch {
          /* Neither synchronous nor asynchronous diagnostic failures replace the operation outcome. */
        }
      }
    },
  };
  return known;
  async function record(
    outcome: OperationRecord["outcome"],
    errorCode?: string,
    causes: FailureCauses = {},
    providerEvidence?: string,
  ): Promise<void> {
    await deps.store.update((state) => {
      recordActivity(state, {
        id: operationId,
        projectId: known.project?.id,
        project: known.project?.name,
        target: known.target?.name ?? known.aimed,
        ...(known.component ? { component: known.component } : {}),
        action: command.action,
        outcome,
        occurredAt: deps.now(),
        ...((message) => (message ? { message } : {}))(
          [known.note, errorCode, killedMessage(tracking()!)]
            .filter((part) => part !== undefined)
            .join(": "),
        ),
      });
      if (
        command.action === "deploy" &&
        known.project &&
        (outcome === "deployed" ||
          outcome === "unchanged" ||
          outcome === "failed")
      ) {
        // A deploy that finished names what its Target now runs; a failed one names what it set out to deploy.
        const source =
          outcome === "failed" || !known.target
            ? known.deploySource
            : {
                ...(known.target.branch ? { branch: known.target.branch } : {}),
                ...(known.target.commit ? { commit: known.target.commit } : {}),
              };
        recordDeployment(state, {
          id: operationId,
          projectId: known.project.id,
          project: known.project.name,
          target: known.target?.name ?? known.aimed ?? String(command.target),
          ...(known.target ? { targetId: known.target.id } : {}),
          kind: command.target === PREVIEW_SELECTOR ? "preview" : "stable",
          ...(source?.branch ? { branch: source.branch } : {}),
          ...(source?.commit ? { commit: source.commit } : {}),
          ...(known.deploySource?.previousCommit
            ? { previousCommit: known.deploySource.previousCommit }
            : {}),
          outcome,
          ...(outcome === "deployed" && known.deployKept.length
            ? { kept: [...known.deployKept] }
            : {}),
          ...(known.deployReceipt.served?.from
            ? { servedAt: known.deployReceipt.served.from }
            : {}),
          startedAt:
            known.deploySource?.startedAt ??
            tracking()?.view.startedAt ??
            deps.now(),
          finishedAt: deps.now(),
          ...(errorCode ? { message: errorCode } : {}),
        });
      }
    });
    try {
      await deps.diagnostic({
        operationId,
        action: command.action,
        outcome,
        project: known.project?.name,
        target: known.target?.name ?? known.aimed,
        errorCode,
        ...causes,
        ...(providerEvidence ? { evidence: providerEvidence } : {}),
      });
    } catch {
      /* Diagnostic failure cannot change an already recorded operation. */
    }
  }
  async function finish(
    outcome: OperationRecord["outcome"],
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    await record(outcome);
    const stops = tracking()?.view.stops;
    return {
      ...(stops?.length ? { stops } : {}),
      operationId,
      project: known.project?.name,
      target: known.target?.name,
      action: command.action,
      outcome,
      branch: known.target?.branch,
      commit: known.target?.commit,
      ...extra,
    };
  }
}
