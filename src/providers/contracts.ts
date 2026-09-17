/** Providers own external effects; runtime chooses policy and supplies resolved inputs. */
export interface ManagedProcess {
  readonly key: string;
  readonly componentName: string;
  readonly command: readonly string[];
  readonly cwd: string;
  /** Used to spawn the process and never written to disk: a later start is given a freshly composed environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly logRoot: string;
  /** The caller's name for this one process; every observation of it, running or exited, carries it back. */
  readonly incarnation: string;
}
/** A supervisor starts a process once and never starts it again on its own: whether an exit is retried is the runtime's decision.
 * A stopped observation with `exitCode` or `signal` is recorded evidence of how `incarnation` ended. Without either, how the
 * process ended is unknown: it was stopped on request, never started, or its evidence is gone. */
export interface ProcessObservation {
  readonly state: "running" | "stopped" | "unknown";
  readonly pid?: number;
  readonly incarnation?: string;
  readonly exitCode?: number;
  /** The signal that ended the process when it did not exit by itself. */
  readonly signal?: string;
  readonly reason?: string;
}
/** One readiness probe. A failed probe carries what was observed: an HTTP status, a connection error, or a command's exit code and last output line. */
export type HealthCheck =
  { readonly ready: true } | { readonly ready: false; readonly reason: string };
export interface Supervisor {
  ensureRunning(
    request: ManagedProcess,
  ): Promise<{ outcome: "started" | "unchanged"; pid?: number }>;
  stop(key: string): Promise<{ outcome: "stopped" | "unchanged" }>;
  observe(key: string, signal?: AbortSignal): Promise<ProcessObservation>;
  /** Stops every owned process; used when the Host must end with nothing running. */
  shutdown(): Promise<void>;
  /** Releases in-memory ownership and leaves processes running; recorded leases let the next daemon adopt them. */
  detach(): Promise<void>;
}
export interface CommandRequest {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Receives each chunk of output as the command produces it; the result still carries the bounded whole. */
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The command was killed at its budget: exitCode is 1 and the streams hold what it produced before then. */
  readonly timedOut?: true;
}
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;
export interface TargetLogEntry {
  readonly timestamp: string;
  readonly component: string;
  /** health lines are readiness probe evidence written when the observation changes. */
  readonly stream: "stdout" | "stderr" | "health" | "unknown";
  readonly line: string;
}
