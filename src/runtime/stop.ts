import { RigError } from "../domain/errors";
import type { TargetRecord } from "../domain/runtime";
import type { TargetLifecycle } from "./lifecycle";
/** Explicit stop resolves interrupted artifacts only after process shutdown is verified.
 * Deployment transitions retain their own checkpoint and use lifecycle.down directly.
 */
export async function stopRecordedTarget(
  target: TargetRecord,
  lifecycle: TargetLifecycle,
): Promise<{ outcome: "stopped" | "unchanged" }> {
  let result: { outcome: "stopped" | "unchanged" };
  try {
    result = await lifecycle.down(target);
  } catch (error) {
    if (error instanceof RigError && error.code === "STOP_HOOKS")
      await lifecycle.restoreEffects(target);
    throw error;
  }
  await lifecycle.restoreEffects(target);
  return result;
}
