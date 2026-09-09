/** Providers own external effects; runtime chooses policy and supplies resolved inputs. */
export interface ManagedProcess {
  readonly key: string;
  readonly componentName: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logRoot: string;
  readonly keepAlive?: boolean;
}
export interface ProcessObservation {
  readonly state: "running" | "stopped" | "unknown";
  readonly pid?: number;
  readonly exitCode?: number;
  readonly restartPending?: boolean;
  readonly reason?: string;
}
export interface Supervisor {
  ensureRunning(
    request: ManagedProcess,
  ): Promise<{ outcome: "started" | "unchanged"; pid?: number }>;
  stop(key: string): Promise<{ outcome: "stopped" | "unchanged" }>;
  observe(key: string, signal?: AbortSignal): Promise<ProcessObservation>;
  shutdown(): Promise<void>;
}
export interface CommandRequest {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;
export interface TargetLogEntry {
  readonly timestamp: string;
  readonly component: string;
  readonly stream: "stdout" | "stderr" | "unknown";
  readonly line: string;
}
