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
 * command printed before its budget ran out. All of it is recorded before a command that succeeded returns. A failing
 * command, one that exits non-zero, runs past its budget or fails outright, waits for its recording only up to a bound,
 * then returns or fails so its own failure is reported: a slow recording still finishes, just after. */
export type TargetCommand = (
  command: string,
  target: TargetRecord,
  env: Record<string, string>,
  timeoutSeconds: number,
  componentName?: string,
  cwd?: string,
) => Promise<CommandResult>;
/** How long a failing command waits for its output to reach the Target log: a log that cannot be written never holds
 * back the failure. */
const FAILURE_RECORDING_MS = 5_000;
/** Target commands run by `run`. The command's process group is recorded with the Target's supervisor in `supervisors`
 * under the Target's preparation key before the command runs, so a daemon that dies meanwhile leaves it to the next one,
 * and forgotten once the command ended and nothing it started still runs: a process it left in the background is stopped
 * then, and when that fails the command fails PREPARATION_LEFTOVER with the record kept. A failing command waits at most
 * `failureRecordingMs` (FAILURE_RECORDING_MS when absent) for its output to be recorded before it reports its failure. */
export function createTargetCommand(options: {
  run: CommandRunner;
  supervisors: ReadonlyMap<string, Supervisor>;
  output: Pick<TargetOutput, "liveRecorder" | "recordOutput">;
  failureRecordingMs?: number;
}): TargetCommand {
  const recordingMs = options.failureRecordingMs ?? FAILURE_RECORDING_MS;
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
    // Every line the command printed is in the Target log before it returns or fails. A runner that does not stream
    // hands over its whole output at the end instead.
    const record = async (result?: CommandResult) => {
      if (!(await live.finish()) && result)
        await options.output.recordOutput(result, target, componentName);
    };
    // A failing command waits a while for that, then goes on to its own failure whatever became of the recording.
    const recordWithin = async (result?: CommandResult) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        record(result).catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, recordingMs);
        }),
      ]);
      clearTimeout(timer);
    };
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
      await recordWithin();
      throw error;
    }
    // What the command left running in its group is stopped before the record of the group goes.
    const leftover = await owner?.disown?.(key).then(
      () => undefined,
      (error: unknown) =>
        new RigError(
          "PREPARATION_LEFTOVER",
          `A process the ${componentName} command of ${target.name} left running could not be stopped.`,
          `Run ${rigCommand("down", { target })} to stop it, then retry.`,
          { component: componentName },
          failureCauses(error),
        ),
    );
    if (leftover) {
      await recordWithin(result);
      throw leftover;
    }
    // A command that exited non-zero or ran past its budget is a failure its caller reports from the result.
    if (result.exitCode !== 0 || result.timedOut) await recordWithin(result);
    else await record(result);
    return result;
  };
}
