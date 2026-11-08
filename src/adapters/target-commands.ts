import type { TargetRecord } from "../domain/runtime";
import type {
  CommandResult,
  CommandRunner,
  Supervisor,
} from "../providers/contracts";
import { RigError, failureCauses } from "../domain/errors";
import { rigCommand } from "../domain/rig-command";
import { preparationProcessKey } from "../runtime/lifecycle";
import type { TargetOutput } from "./target-output";

/** Runs a Target's build or dependency installation: `command` through /bin/sh in `cwd` (the workspace when absent) with
 * `env`, within `timeoutSeconds`, its output recorded under `componentName` (setup when absent), including what a killed
 * command printed before its budget ran out. */
export type TargetCommand = (
  command: string,
  target: TargetRecord,
  env: Record<string, string>,
  timeoutSeconds: number,
  componentName?: string,
  cwd?: string,
) => Promise<CommandResult>;
/** Target commands run by `run`. The command's process group is recorded with the Target's supervisor in `supervisors`
 * under the Target's preparation key before the command runs, so a daemon that dies meanwhile leaves it to the next one,
 * and forgotten once the command ended and nothing it started still runs: a process it left in the background is stopped
 * then, and when that fails the command fails PREPARATION_LEFTOVER with the record kept. */
export function createTargetCommand(options: {
  run: CommandRunner;
  supervisors: ReadonlyMap<string, Supervisor>;
  output: Pick<TargetOutput, "liveRecorder" | "recordOutput">;
}): TargetCommand {
  return async (
    command,
    target,
    env,
    timeoutSeconds,
    componentName = "setup",
    cwd = target.plan.workspacePath,
  ) => {
    const live = options.output.liveRecorder(target, componentName);
    // A plan whose supervisor this rigd lacks records nothing; none of its Services can start either (PROVIDER_MISSING).
    const owner = options.supervisors.get(
        target.plan.providers.processSupervisor,
      ),
      key = preparationProcessKey(target);
    let result: CommandResult;
    try {
      result = await options.run({
        command: ["/bin/sh", "-c", command],
        cwd,
        env,
        timeoutMs: timeoutSeconds * 1000,
        onOutput: live.receive,
        ...(owner?.own ? { started: (pid) => owner.own!(key, pid) } : {}),
      });
    } catch (error) {
      // The command's own failure is the one reported; a record kept because its group could not be stopped keeps what
      // still runs addressable for rig down.
      await owner?.disown?.(key).catch(() => {});
      throw error;
    }
    // What the command left running in its group is stopped before the record of the group goes.
    await owner?.disown?.(key).catch((error: unknown) => {
      throw new RigError(
        "PREPARATION_LEFTOVER",
        `A process the ${componentName} command of ${target.name} left running could not be stopped.`,
        `Run ${rigCommand("down", { target })} to stop it, then retry.`,
        { component: componentName },
        failureCauses(error),
      );
    });
    // A runner that does not stream hands over its whole output at the end instead.
    if (!(await live.finish()))
      await options.output.recordOutput(result, target, componentName);
    return result;
  };
}
