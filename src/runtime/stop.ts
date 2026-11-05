import type { TargetRecord } from "../domain/runtime";
import type { TargetLifecycle } from "./lifecycle";
/** Explicit stop resolves interrupted artifacts only after process shutdown is verified.
 * Deployment transitions retain their own checkpoint and use lifecycle.down directly.
 */
export async function stopRecordedTarget(
  target: TargetRecord,
  lifecycle: TargetLifecycle,
  /** A start follows, as in `rig restart`: see `TargetLifecycle.down`. */
  startFollows = false,
): Promise<{ outcome: "stopped" | "unchanged" }> {
  const result = await lifecycle.down(
    target,
    undefined,
    startFollows ? target.plan : undefined,
  );
  await lifecycle.restoreEffects(target);
  return result;
}
