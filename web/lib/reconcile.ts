import type { Failure, Outcome } from "./outcome";
import type { OperationResult, Settlement } from "./types";

/** Pure: how a lost reply resolves once rigd has been asked where the Operation stands. `undefined`
 * means keep asking. A finished Operation answers as its command would have; one rigd never saw is
 * a failure that names the transport error. */
export function resolveSettlement(
  settlement: Settlement,
  operation: {
    operationId: string;
    action: string;
    project?: string;
    target?: string;
  },
  transportError: string,
): Outcome<OperationResult> | undefined {
  if (settlement.state === "running" || settlement.state === "waiting")
    return undefined;
  if (settlement.state === "finished")
    return settlement.outcome === "succeeded"
      ? { ok: true, value: { ...operation, outcome: settlement.outcome } }
      : {
          ok: false,
          failure: {
            code: settlement.outcome.toUpperCase(),
            message:
              settlement.message ??
              `The ${operation.action} ${settlement.outcome}.`,
            hint: "Open the Operation in Activity for the full record.",
            operationId: operation.operationId,
          },
        };
  return {
    ok: false,
    failure: {
      code: "REPLY_LOST",
      message: `The reply did not reach this page (${transportError}), and rigd has no record of the Operation.`,
      hint: "Reload the page; if the change did not happen, try it again.",
      operationId: operation.operationId,
    },
  };
}
/** Pure: the failure a page shows when a Server Action itself could not be reached. */
export const transportFailure = (error: unknown): Failure => ({
  code: "UNREACHABLE",
  message: error instanceof Error ? error.message : String(error),
  hint: "The dashboard could not reach its server. Check the connection and try again.",
});
