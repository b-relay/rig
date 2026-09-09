/** Diagnostics accept metadata, never config, commands, secrets, or Target output. */
export interface DiagnosticEntry {
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  operationId?: string;
  action?: string;
  project?: string;
  target?: string;
  outcome?: string;
  code?: string;
}
export interface DiagnosticWriteResult {
  path?: string;
  error?: string;
}
export interface DiagnosticLog {
  /** Failure is reported as data so logging cannot replace the command outcome. */
  record(entry: DiagnosticEntry): Promise<DiagnosticWriteResult>;
}
