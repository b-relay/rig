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
  initializationInfo(
    path: string,
  ): Promise<{
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
  reservePorts(
    requests: readonly { name: string; preferred?: number }[],
    occupied: ReadonlySet<number>,
    dynamic: boolean,
  ): Promise<Record<string, number>>;
  logs(
    target: TargetRecord,
    after: string | undefined,
    lines: number,
  ): Promise<{ entries: TargetLogEntry[]; cursor: string }>;
  exists(path: string): Promise<boolean>;
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
  diagnostic(event: {
    operationId: string;
    action: string;
    outcome: string;
    project?: string;
    target?: string;
    errorCode?: string;
  }): Promise<void>;
}
