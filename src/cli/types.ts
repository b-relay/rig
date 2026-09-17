import type { ProjectStatusReader } from "../domain/project-status";
import type { CliInteraction } from "./interaction";
import type { RuntimeCommand } from "../daemon/protocol";
import type { DiagnosticLog } from "../diagnostics/types";
import type { Recipe } from "../recipes/catalog";

/** The only terminal effect; tests capture the same text a terminal receives. */
export interface UserOutput {
  write(text: string): void;
  error(text: string): void;
}
export interface CliDependencies {
  root: string;
  cwd: string;
  client: ProjectStatusReader & {
    /** The signal, when given, abandons the request; rigd keeps running whatever it was asked. */
    command(request: RuntimeCommand, signal?: AbortSignal): Promise<unknown>;
  };
  output: UserOutput;
  diagnostics: DiagnosticLog;
  newOperationId: () => string;
  interaction?: CliInteraction;
  /** The recipes `rig recipe list` and `generate` offer; the bundled catalog when absent. */
  recipes?: readonly Recipe[];
  /** Cancellation: honoured before a mutation is submitted and during reads and follows; acknowledged, not honoured, once a mutation is in flight. */
  signal?: AbortSignal;
  /** Detachment: abandons a submitted mutation, which rigd finishes without rig. */
  detach?: AbortSignal;
  /** Resolves after the poll delay or cancellation; must release its wait resources. */
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
export interface DaemonAdmin {
  install(operationId?: string): Promise<unknown>;
  status(): Promise<unknown>;
  uninstall(operationId?: string): Promise<unknown>;
}
