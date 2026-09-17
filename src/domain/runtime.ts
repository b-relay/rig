import type { TargetPlan } from "../config/types";

export interface ProjectRecord {
  id: string;
  name: string;
  repoPath: string;
  configPath: string;
  createdAt: string;
}

/** The recorded outcome of one build unit. `started` read by anything but the operation that wrote it means the
 * command may or may not have finished: the outcome is unknown and the unit is never rerun under this identity. */
export interface BuildOutcome {
  state: "started" | "succeeded" | "failed";
  /** Digest of the unit's public policy: command, public env, env-file paths and workspace; never env-file values. */
  policy: string;
  commit?: string;
  startedAt: string;
  finishedAt?: string;
}
/** Build outcomes of one Deployment, by unit id. */
export interface Preparation {
  /** The workspace the outcomes belong to; a new revision starts a fresh scope. */
  deployment: string;
  units: Record<string, BuildOutcome>;
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
  /** Irreversible Preview cleanup is pending; retain stopped inventory for retry. */
  destructionPending?: true;
  /** Present until deployment commits; absence retains legacy completion semantics. */
  deploymentIncomplete?: true;
  preparation?: Preparation;
  /** Revision of the rig.yaml a Working copy plan was made from. */
  configRevision?: string;
  recovery?: {
    plan: TargetPlan;
    /** Build outcomes of the plan restored by rollback. */
    preparation?: Preparation;
    branch?: string;
    commit?: string;
    desired: "running" | "stopped";
    /** Completion state of the plan restored by rollback. */
    deploymentIncomplete?: true;
    stage: "pending" | "blocked" | "committing";
    /** Operation that opened the transition; live only inside the daemon that ran it. */
    operationId?: string;
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
    | "forgotten"
    | "installed"
    | "uninstalled";
  occurredAt: string;
  message?: string;
}

export interface RuntimeState {
  version: 3;
  projects: ProjectRecord[];
  targets: TargetRecord[];
  activity: OperationRecord[];
}

export interface StateStore {
  read(): Promise<RuntimeState>;
  /** One daemon owns writes. Updates are serialized and committed atomically. */
  update(change: (state: RuntimeState) => void | Promise<void>): Promise<void>;
}
