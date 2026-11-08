import type { TargetRecord } from "../domain/runtime";
import type { CommandResult, TargetLogEntry } from "../providers/contracts";
import type { LogRetention } from "../domain/log-retention";
import { appendTargetLogEntries } from "../providers/target-log";
import { outputLines } from "../domain/output-records";
import { privateDirectory } from "../providers/private-files";

/** Records what a Target's commands print, and other lines of evidence, in the Target log. */
export interface TargetOutput {
  /** Appends `lines` under `componentName`, each stamped as it is recorded; nothing when there are none. `makeDirectory`
   * makes the log directory, `privateDirectory` unless a caller must not bring back a deleted one. */
  recordLines(
    target: TargetRecord,
    componentName: string,
    stream: TargetLogEntry["stream"],
    lines: readonly string[],
    makeDirectory?: typeof privateDirectory,
  ): Promise<void>;
  /** Records a finished command's whole output, stdout then stderr, line by line. */
  recordOutput(
    result: CommandResult,
    target: TargetRecord,
    componentName: string,
  ): Promise<void>;
  /** Records output lines as a running command produces them (see `outputLines`), each at the time it was seen;
   * finish flushes a trailing partial line and says whether anything was streamed. */
  liveRecorder(
    target: TargetRecord,
    componentName: string,
  ): {
    receive(stream: "stdout" | "stderr", chunk: string): void;
    finish(): Promise<boolean>;
  };
}
/** Target log recording under `root`. `recordingTime` stamps each entry; `logRetention` is read for every append, the
 * default when absent. */
export function createTargetOutput(options: {
  root: string;
  recordingTime: () => string;
  logRetention?: () => Promise<LogRetention>;
}): TargetOutput {
  const recordLines: TargetOutput["recordLines"] = async (
    target,
    componentName,
    stream,
    lines,
    makeDirectory = privateDirectory,
  ) => {
    if (!lines.length) return;
    await makeDirectory(options.root, target.logRoot);
    await appendTargetLogEntries(
      options.root,
      target.logRoot,
      lines.map((line) => ({
        timestamp: options.recordingTime(),
        component: componentName,
        stream,
        line,
      })),
      await options.logRetention?.(),
      makeDirectory,
    );
  };
  return {
    recordLines,
    async recordOutput(result, target, componentName) {
      for (const stream of ["stdout", "stderr"] as const) {
        const lines = outputLines();
        await recordLines(target, componentName, stream, [
          ...lines.push(result[stream]),
          ...lines.end(),
        ]);
      }
    },
    liveRecorder(target, componentName) {
      const lines = { stdout: outputLines(), stderr: outputLines() };
      let streamed = false;
      let writes: Promise<void> = Promise.resolve();
      const record = (stream: "stdout" | "stderr", complete: string[]) => {
        if (complete.length)
          writes = writes.then(() =>
            recordLines(target, componentName, stream, complete),
          );
      };
      const receive = (stream: "stdout" | "stderr", chunk: string) => {
        streamed = true;
        record(stream, lines[stream].push(chunk));
      };
      const finish = async () => {
        for (const stream of ["stdout", "stderr"] as const)
          record(stream, lines[stream].end());
        await writes;
        return streamed;
      };
      return { receive, finish };
    },
  };
}
