import type { ProjectStatusReader } from "../domain/project-status";
import type { CliInteraction } from "./interaction";
import type { RuntimeCommand } from "../daemon/protocol";
import type { DiagnosticLog } from "../diagnostics/types";
import type { Recipe } from "../recipes/catalog";

/** The Project's own files, as `rig recipe generate` writes a recipe's files into them. */
export interface ProjectFiles {
  /** The Project directory for `cwd`: the nearest directory at or above it holding rig.yaml, looking no further than a
   * repository root; `cwd` itself when there is none. */
  projectDirectory(cwd: string): Promise<string>;
  /** The text of the file at `path` (relative, `/`-separated) under `directory`; undefined when there is none. */
  read(directory: string, path: string): Promise<string | undefined>;
  /** Creates the file at `path` under `directory` (and its directory), mode 644. Fails RECIPE_FILE_WRITE when it
   * exists or cannot be written. */
  create(directory: string, path: string, text: string): Promise<void>;
}
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
  /** Where `rig recipe generate` writes a recipe's files. Absent for a caller that never generates one with files:
   * generating such a recipe then fails RECIPE_FILES_UNAVAILABLE. */
  projectFiles?: ProjectFiles;
  /** Cancellation: honoured before a mutation is submitted and during reads and follows; acknowledged, not honoured, once a mutation is in flight. */
  signal?: AbortSignal;
  /** Detachment: abandons a submitted mutation, which rigd finishes without rig. */
  detach?: AbortSignal;
  /** Resolves after the poll delay or cancellation; must release its wait resources. */
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** The local clock countdowns and deadlines are shown by; the platform clock when absent. */
  now?: () => Date;
  /** stderr is a terminal: progress is redrawn in place there. Without one, it is plain appended lines. */
  liveOutput?: boolean;
  /** The terminal's width, to which live progress lines are cut; 80 when absent. */
  terminalColumns?: number;
}
export interface DaemonAdmin {
  install(operationId?: string): Promise<unknown>;
  status(): Promise<unknown>;
  uninstall(operationId?: string): Promise<unknown>;
}
