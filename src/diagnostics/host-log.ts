import { readHostConfig, type HostConfig } from "../config";
import {
  createFileDiagnosticLog,
  type FileDiagnosticOptions,
} from "./file-log";
import type { DiagnosticLog } from "./types";

/** The diagnostic log Host config asks for: its `diagnostics` retention and level. `rig` and `rigd` both open theirs
 * here, so the snake_case keys are mapped in one place. */
export function configuredDiagnosticLog(
  options: Pick<FileDiagnosticOptions, "root" | "source" | "now">,
  host: HostConfig,
): DiagnosticLog {
  return createFileDiagnosticLog({
    ...options,
    retentionDays: host.diagnostics.retention_days,
    level: host.diagnostics.level,
  });
}

/** Acquire Host policy lazily so help and parser-only requests never depend on valid config. */
export function createHostDiagnosticLog(
  options: Pick<FileDiagnosticOptions, "root" | "source" | "now">,
): DiagnosticLog {
  let selected: Promise<DiagnosticLog> | undefined;
  return {
    async record(entry) {
      selected ??= readHostConfig(options.root).then(
        (host) => configuredDiagnosticLog(options, host),
        () => createFileDiagnosticLog(options),
      );
      return await (await selected).record(entry);
    },
  };
}
