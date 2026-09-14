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
/** Restart's stop half: processes are verified stopped and up follows, so failed shutdown hooks are reported as
 * warnings instead of ending the command with the Target down. Other stop failures still abort. */
export async function stopBeforeRestart(
  target: TargetRecord,
  lifecycle: TargetLifecycle,
): Promise<{ warnings: string[] }> {
  try {
    await stopRecordedTarget(target, lifecycle);
    return { warnings: [] };
  } catch (error) {
    if (!(error instanceof RigError) || error.code !== "STOP_HOOKS") throw error;
    return { warnings: shutdownHookWarnings(error) };
  }
}
function shutdownHookWarnings(error: RigError): string[] {
  const failures = Array.isArray(error.details?.hookFailures) ? error.details.hookFailures : [];
  const warnings = failures.map(
    (failure) => `Shutdown hook failed: ${failure instanceof Error ? failure.message : String(failure)}`,
  );
  return warnings.length ? warnings : [`Shutdown hook failed: ${error.message}`];
}
