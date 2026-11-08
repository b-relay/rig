import { rigCommand } from "../domain/rig-command";
import { isStopDetached } from "../domain/stop-budget";
import { RigError, failureCauses, failureReason } from "../domain/errors";
import type {
  RouteWithdrawal,
  StopControl,
  TargetEffects,
  TargetLifecycle,
} from "./lifecycle";
import type { ServiceActivation } from "./service-activation";
import type { TargetStops } from "./target-stops";

/** Taking a Target out of service under one checkpoint (`retire`), and withdrawing routes so they can be published again
 * (`withdrawRoutes`). Each owns its rollback: a retirement that fails restores its effects and starts the Target again
 * when it is meant to run; a withdrawal that fails publishes again what it withdrew. */
export type TargetRetirement = Pick<
  TargetLifecycle,
  "retire" | "withdrawRoutes"
>;

export function createTargetRetirement(
  effects: TargetEffects,
  guarded: (stops: StopControl | undefined) => TargetEffects,
  /** How a retirement stops the Target. */
  stopping: Pick<TargetStops, "down">,
  /** How a retirement that failed starts the Target again. */
  activation: Pick<ServiceActivation, "up">,
): TargetRetirement {
  return {
    async retire(target, publishRemoval, stops) {
      const effects = guarded(stops);
      const checkpoint = await effects.checkpoint(target);
      let finalizationPending = false;
      try {
        await stopping.down(target, stops);
        await effects.removeRoute(target);
        await effects.retireArtifacts(target);
        await publishRemoval?.();
        finalizationPending = true;
        await checkpoint.commit();
      } catch (error) {
        if (finalizationPending)
          throw new RigError(
            "RETIRE_COMMIT_PENDING",
            publishRemoval
              ? "The Target inventory was removed but checkpoint finalization failed."
              : "The Target inventory is retained, but retirement checkpoint finalization failed.",
            publishRemoval
              ? "Preserve its effect checkpoint; the retired Target must not be restarted."
              : "Preserve its effect checkpoint and retry the operation; the Target must not be restarted.",
            {},
            failureCauses(error),
          );
        // A detached stop is left as a crash leaves it: the Services keep stopping and the checkpoint stays for the retry.
        if (isStopDetached(error)) throw error;
        try {
          await checkpoint.rollback();
          if (target.desired === "running") await activation.up(target);
        } catch (recovery) {
          throw new RigError(
            "RETIRE_ROLLBACK",
            "Target retirement failed and its saved effects could not be restored.",
            `Run ${rigCommand("down", { target })} and inspect its effect checkpoint.`,
            {},
            failureCauses(error, recovery),
          );
        }
        throw error;
      }
    },
    async withdrawRoutes(targets) {
      const withdrawn: RouteWithdrawal[] = [];
      /** Publishes again, in the order they were withdrawn, every route this call took out; each is its own block, so
       * the order only keeps the route file as it was. Every route is tried; ROUTE_RESTORE names the hostnames of those
       * that could not be published again. */
      const restore = async () => {
        const failed: string[] = [];
        let first: unknown;
        for (const withdrawal of withdrawn)
          try {
            await withdrawal.restore();
          } catch (error) {
            first ??= error;
            failed.push(...withdrawal.hostnames);
          }
        if (failed.length)
          throw new RigError(
            "ROUTE_RESTORE",
            `The routes for ${failed.join(", ")} could not be published again.`,
            "Their Targets are stopped; rig up or rig deploy of each publishes its route again. Run rig doctor before retrying.",
            { hostnames: failed },
            failureCauses(first),
          );
      };
      try {
        for (const target of targets) {
          const withdrawal = await effects.withdrawRoute(target);
          if (withdrawal) withdrawn.push(withdrawal);
        }
      } catch (error) {
        /** The hostnames a failure names as withdrawn and not published again (WITHDRAW_ROLLBACK, ROUTE_RESTORE). */
        const missing = (failure: unknown): string[] =>
          failure instanceof RigError &&
          Array.isArray(failure.details.hostnames)
            ? failure.details.hostnames.map(String)
            : [];
        try {
          await restore();
        } catch (recovery) {
          throw new RigError(
            "WITHDRAW_ROLLBACK",
            `A route could not be withdrawn (${failureReason(error)}), and the routes for ${[...missing(error), ...missing(recovery)].join(", ")} withdrawn meanwhile could not be published again.`,
            "Their Targets are stopped, so nothing was served through them; rig up or rig deploy of each publishes its route again. Run rig doctor before retrying.",
            { hostnames: [...missing(error), ...missing(recovery)] },
            failureCauses(error, recovery),
          );
        }
        throw error;
      }
      return {
        hostnames: withdrawn.flatMap((withdrawal) => withdrawal.hostnames),
        restore,
      };
    },
  };
}
