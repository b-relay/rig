import type { FailureCauses } from "../domain/errors";
import type {
  ConfigDocument,
  HostConfig,
  ProjectConfig,
  ResolveTargetPlanInput,
  TargetPlan,
} from "../config/types";
import type { RuntimeCommand } from "../daemon/protocol";
import type {
  OperationRecord,
  ProjectRecord,
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import type { TargetLogEntry } from "../providers/contracts";
import type { TargetLifecycle } from "./lifecycle";
import type { ObservationEffects } from "./status";
export interface ProjectDocuments {
  discover(
    path: string,
  ): Promise<{ repoPath: string; document: ConfigDocument<ProjectConfig> }>;
  read(path: string): Promise<ConfigDocument<ProjectConfig>>;
  initializationInfo(path: string): Promise<{
    name: string;
    productionBranch: string;
    gitRequired: boolean;
    existing: boolean;
  }>;
  identifyInitialization(
    path: string,
    command: RuntimeCommand,
  ): Promise<{ repoPath: string; name: string }>;
  initialize(
    path: string,
    command: RuntimeCommand,
  ): Promise<ConfigDocument<ProjectConfig>>;
  rename(
    project: ProjectRecord,
    name: string,
  ): Promise<ConfigDocument<ProjectConfig>>;
  resolve(input: ResolveTargetPlanInput): TargetPlan;
  host(): Promise<HostConfig>;
}
export interface DeploymentSources {
  prepare(request: {
    project: string;
    repository: string;
    ref: string;
    destination: string;
  }): Promise<{ workspacePath: string; commit: string }>;
  resolve(repository: string, ref: string): Promise<string>;
  preflight(input: {
    repoPath: string;
    branch: string;
    productionBranch: string;
  }): Promise<{ commit: string; warnings: string[] }>;
  currentBranch(repository: string): Promise<string>;
}
export interface RuntimeFiles {
  /** Delete only a canonical Preview root after verified retirement. Validates all
   * inventory ownership before deletion, never follows symlinks, and rejects
   * DESTROY_OWNERSHIP or DESTROY_CLEANUP. Missing owned bytes permit retry.
   * Caller retains stopped inventory until success; partial deletion is irreversible.
   */
  inspectPreviewDeletion(input: PreviewDeletion): Promise<void>;
  destroyPreview(input: PreviewDeletion): Promise<void>;
  /**
   * Select distinct localhost port numbers, excluding the supplied inventory.
   * `configured` requires preferred ports when present; otherwise choose dynamic
   * ports. `dynamic` ignores preferences (Preview policy). Inventory is read only.
   * Probe sockets are closed before return, including partial failure. No live
   * reservation is transferred: another process may bind before startup, whose
   * failure/readiness remains the process provider and lifecycle owner's concern.
   * Rejects PORT_RESERVED for configured inventory collisions and PORT_UNAVAILABLE
   * for unsuccessful OS probes. Requests have unique names and validated ports.
   */
  selectPorts(input: {
    requests: readonly { name: string; preferred?: number }[];
    occupied: ReadonlySet<number>;
    policy: "configured" | "dynamic";
  }): Promise<Record<string, number>>;
  logs(
    target: TargetRecord,
    after: string | undefined,
    lines: number,
  ): Promise<{ entries: TargetLogEntry[]; cursor: string }>;
}
export interface RuntimeDependencies {
  root: string;
  assertOwnershipReady(): Promise<void>;
  readAdminActivity(): Promise<OperationRecord[]>;
  inspectHost(): Promise<
    {
      name: string;
      ok: boolean;
      message: string;
      reason?: string;
      hint?: string;
    }[]
  >;
  store: StateStore;
  documents: ProjectDocuments;
  sources: DeploymentSources;
  lifecycle: TargetLifecycle;
  observations: ObservationEffects;
  files: RuntimeFiles;
  now(): string;
  id(): string;
  diagnostic(
    event: FailureCauses & {
      operationId: string;
      action: string;
      outcome: string;
      project?: string;
      target?: string;
      errorCode?: string;
    },
  ): Promise<void>;
}

/** Borrowed inventory snapshot under the runtime mutation queue. */
export interface PreviewDeletion {
  root: string;
  target: TargetRecord;
  state: Pick<import("../domain/runtime").RuntimeState, "projects" | "targets">;
}
