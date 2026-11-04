import type { FailureCauses } from "../domain/errors";
/** Diagnostics accept metadata, never config, commands, secrets, or Target output. */
export interface DiagnosticEntry extends FailureCauses {
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  operationId?: string;
  action?: string;
  project?: string;
  target?: string;
  outcome?: string;
  code?: string;
  /** Which control-plane route a transport entry is about: a fixed category, never a URL. */
  route?: string;
  /** The HTTP status a transport entry answered with. */
  status?: string;
  /** How long the request took to answer, in whole milliseconds. */
  durationMs?: string;
  /** A transport failure's class of error, never its message. */
  cause?: string;
  /** How many more of the same outcome this entry stands for since the last one like it. */
  repeated?: string;
  /** Bounded provider output the failure opted into sharing, such as Caddy's rejection line. */
  evidence?: string;
}
export interface DiagnosticWriteResult {
  path?: string;
  error?: string;
}
export interface DiagnosticLog {
  /** Failure is reported as data so logging cannot replace the command outcome. */
  record(entry: DiagnosticEntry): Promise<DiagnosticWriteResult>;
}
