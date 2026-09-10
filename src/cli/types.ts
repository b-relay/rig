import type { ProjectStatusReader } from "../domain/project-status";
import type { CliInteraction } from "./interaction";
import type { RuntimeCommand } from "../daemon/protocol";
import type { DiagnosticLog } from "../diagnostics/types";

/** The only terminal effect; tests capture the same text a terminal receives. */
export interface UserOutput {
  write(text: string): void;
  error(text: string): void;
}
export interface CliDependencies {
  root: string;
  cwd: string;
  client: ProjectStatusReader & {
    command(request: RuntimeCommand): Promise<unknown>;
  };
  output: UserOutput;
  diagnostics: DiagnosticLog;
  newOperationId: () => string;
  interaction?: CliInteraction;
  signal?: AbortSignal;
  /** Resolves after the poll delay or cancellation; must release its wait resources. */
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
export interface DaemonAdmin {
  install(operationId?: string): Promise<unknown>;
  status(): Promise<unknown>;
  uninstall(operationId?: string): Promise<unknown>;
}
