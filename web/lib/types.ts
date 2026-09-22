/** The reply shapes of the rigd control plane. Types only: the page is bundled into the
 * rigd that answers it, so the two can never be different versions. */
import type { RuntimeCommand } from "../../src/daemon/protocol";
import type { RecipeReport } from "../../src/runtime/recipes";
import type { DoctorReport } from "../../src/runtime/doctor";

export type {
  ActivityResult,
  DaemonHealth,
  ListResult,
  LogsResult,
  RuntimeCommand,
} from "../../src/daemon/protocol";
export type {
  ComponentReport,
  ProjectStatusReport,
  TargetReport,
} from "../../src/domain/project-status";
export type { RecipeFinding, RecipeChange } from "../../src/recipes/compare";
export type { ConfigEditorRequest } from "../../src/daemon/config-editor";
export type { DoctorReport, RecipeReport };

export type Action = RuntimeCommand["action"];
export interface QueueResult {
  running?: {
    operationId: string;
    action: string;
    project?: string;
    target?: string;
    startedAt: string;
  };
  waiting: number;
}
/** What every lifecycle, deploy and registration command answers with. */
export interface OperationResult {
  operationId: string;
  project?: string;
  target?: string;
  action: string;
  outcome: string;
  branch?: string;
  commit?: string;
  path?: string;
  repoPath?: string;
  warnings?: string[];
}
export interface InitializationInfo {
  name: string;
  productionBranch: string;
  currentBranch?: string;
  gitRequired: boolean;
  existing: boolean;
}
export interface DeploymentContext {
  project: string;
  repoPath: string;
  productionBranch: string;
  currentBranch: string | null;
  targets: { working: string; stable: string };
}
export interface ConfigReport {
  project: string;
  path: string;
  revision: string;
  config: unknown;
}
export interface ConfigField {
  path: string;
  description: string;
  valueShape: string;
}
export interface ConfigRead {
  project: string;
  configPath: string;
  revision: string;
  raw: string;
  config: unknown;
  fields: ConfigField[];
}
export type ConfigPatch =
  | { op: "set"; path: string[]; value: NonNullable<unknown> | null }
  | { op: "remove"; path: string[] };
export interface ConfigChange {
  project: string;
  configPath: string;
  baseRevision: string;
  nextRevision: string;
  raw: string;
  config: unknown;
  diff: { path: string; before?: unknown; after?: unknown }[];
  applied?: true;
  backupPath?: string;
}
/** The reply each action answers with; an action absent here answers an Operation result. */
export interface Replies {
  list: import("../../src/daemon/protocol").ListResult;
  status: import("../../src/domain/project-status").ProjectStatusReport;
  logs: import("../../src/daemon/protocol").LogsResult;
  activity: import("../../src/daemon/protocol").ActivityResult;
  doctor: DoctorReport;
  config: ConfigReport;
  "recipe-diff": RecipeReport;
  queue: QueueResult;
  "initialization-info": InitializationInfo;
  "deployment-context": DeploymentContext;
  "prepare-uninstall": { ready: true };
  "cancel-uninstall": { cancelled: true };
}
export type Reply<A extends Action> = A extends keyof Replies
  ? Replies[A]
  : OperationResult;
/** Where an Operation the browser lost track of stands, read back from rigd by its id. */
export type Settlement =
  | { state: "running" | "waiting" }
  | { state: "finished"; outcome: string; message?: string; occurredAt: string }
  | { state: "unknown" };
