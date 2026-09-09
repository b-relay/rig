import { readHostConfig } from "../config";
import {
  createFileDiagnosticLog,
  type FileDiagnosticOptions,
} from "./file-log";
import type { DiagnosticLog } from "./types";
/** Acquire Host policy lazily so help and parser-only requests never depend on valid config. */
export function createHostDiagnosticLog(
  options: Pick<FileDiagnosticOptions, "root" | "source" | "now">,
): DiagnosticLog {
  let selected: Promise<DiagnosticLog> | undefined;
  return {
    async record(entry) {
      selected ??= readHostConfig(options.root).then(
        (host) => createFileDiagnosticLog({ ...options, ...host.diagnostics }),
        () => createFileDiagnosticLog(options),
      );
      return await (await selected).record(entry);
    },
  };
}
