import type { TargetPlan } from "../config/types";

export interface ProjectRecord {
  id: string;
  name: string;
  repoPath: string;
  configPath: string;
  createdAt: string;
}

export interface TargetRecord {
  id: string;
  projectId: string;
  name: string;
  kind: "local" | "live" | "preview";
  branch?: string;
  commit?: string;
  plan: TargetPlan;
  desired: "running" | "stopped";
  createdAt: string;
  updatedAt: string;
  /** Stable storage paths survive a Project rename. */
  logRoot: string;
  sourceRoot?: string;
  /** Present until deployment commits; absence retains legacy completion semantics. */
  deploymentIncomplete?: true;
  recovery?: {
    plan: TargetPlan;
    branch?: string;
    commit?: string;
    desired: "running" | "stopped";
    /** Completion state of the plan restored by rollback. */
    deploymentIncomplete?: true;
    stage: "pending" | "blocked" | "committing";
  };
}

export interface OperationRecord {
  id: string;
  projectId?: string;
  project?: string;
  target?: string;
  action: string;
  outcome:
    | "started"
    | "stopped"
    | "deployed"
    | "failed"
    | "unchanged"
    | "registered"
    | "renamed"
    | "repointed"
    | "installed"
    | "uninstalled";
  occurredAt: string;
  message?: string;
}

export interface RuntimeState {
  version: 2;
  projects: ProjectRecord[];
  targets: TargetRecord[];
  activity: OperationRecord[];
}

export interface StateStore {
  read(): Promise<RuntimeState>;
  /** One daemon owns writes. Updates are serialized and committed atomically. */
  update(change: (state: RuntimeState) => void | Promise<void>): Promise<void>;
}
