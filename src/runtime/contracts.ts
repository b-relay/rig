import type { Recipe } from "../recipes/catalog";
import type { ProxyPublication } from "../domain/proxy-publication";
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
import type { ObservationDeadline } from "./bounded-observations";
export interface ProjectDocuments {
  /** The nearest config at or above `path` inside its Git working repository; a directory
   * that is not a repository is searched alone and reported with `gitRequired`. */
  discover(path: string): Promise<{
    repoPath: string;
    document: ConfigDocument<ProjectConfig>;
    gitRequired: boolean;
  }>;
  read(path: string): Promise<ConfigDocument<ProjectConfig>>;
  initializationInfo(path: string): Promise<{
    name: string;
    /** The branch init would record: an existing config's, origin/HEAD, or the host default. */
    productionBranch: string;
    /** The checked-out branch, when there is one; shown so a confirmation can name it. */
    currentBranch?: string;
    gitRequired: boolean;
    existing: boolean;
  }>;
  identifyInitialization(
    path: string,
    command: RuntimeCommand,
  ): Promise<{
    repoPath: string;
    name: string;
    /** The config init would keep, when one already exists. */
    configPath?: string;
  }>;
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
  /** Remove a prepared workspace, its install output, and its worktree registration; a workspace
   * already deleted is only pruned. Callers pass only workspaces no inventory record references. */
  release(request: { project: string; workspacePath: string }): Promise<void>;
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
   * Rejects PORT_RESERVED, naming the owning Target, for configured inventory collisions and PORT_UNAVAILABLE
   * for unsuccessful OS probes. Requests have unique names and validated ports.
   */
  selectPorts(input: {
    requests: readonly { name: string; preferred?: number }[];
    occupied: ReadonlyMap<number, { target: string; project: string }>;
    policy: "configured" | "dynamic";
  }): Promise<Record<string, number>>;
  logs(
    target: TargetRecord,
    after: string | undefined,
    lines: number,
  ): Promise<{ entries: TargetLogEntry[]; cursor: string }>;
}
/** Bounded evidence of a background channel that is failing inside the daemon. */
export interface RuntimeNotice {
  channel: string;
  count: number;
  firstAt: string;
  lastAt: string;
  message: string;
  consequence: string;
  hint: string;
}
export interface RuntimeDependencies {
  root: string;
  /** Background failures the daemon has noted since it started; doctor reports each one. */
  notices?(): RuntimeNotice[];
  /** The recipes that recipe comparisons are made against; the bundled catalog when absent. */
  recipes?: readonly Recipe[];
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
  inspectProxy(): Promise<ProxyPublication>;
  store: StateStore;
  documents: ProjectDocuments;
  sources: DeploymentSources;
  lifecycle: TargetLifecycle;
  observations: ObservationEffects;
  /** Shared budget for one read-only observation pass (status, doctor, registration, prepare-uninstall). */
  observationBudgetMs: number;
  /** Schedules that budget's expiry; the timer in production, scripted in tests. */
  observationDeadline: ObservationDeadline;
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
      /** A filesystem path the outcome concerns, such as a pruned checkpoint. */
      path?: string;
      /** Why something was left in place. */
      reason?: string;
      /** Bounded provider output the failure opted into sharing. */
      evidence?: string;
    },
  ): Promise<void>;
}

/** Borrowed inventory snapshot under the runtime mutation queue. */
export interface PreviewDeletion {
  root: string;
  target: TargetRecord;
  state: Pick<import("../domain/runtime").RuntimeState, "projects" | "targets">;
}
