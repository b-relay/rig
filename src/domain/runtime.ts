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

/** How the latest process of a Service ended, as far as Rig knows. `unknown` is a finding, not a gap: the process is gone and
 * nothing recorded how, so nothing may treat it as a clean exit, a failure or a requested stop. */
export type ServiceOutcome =
  | { kind: "exited"; exitCode?: number; signal?: string; at: string }
  /** A start could not be verified and its process was stopped: `activation-failed` for an automatic attempt, which counts
   * as a failure to retry, `start-failed` for an operator's own start, which is theirs to repeat. */
  | {
      kind: "activation-failed" | "start-failed";
      errorCode: string;
      at: string;
    }
  | { kind: "unknown"; at: string };
/** What Rig intends for one Service of one Deployment and what it knows about that Service's latest process. */
export interface ServiceRun {
  /** The workspace the Service was started from; a record of another Deployment describes nothing. */
  deployment: string;
  /** `stopped` once an operator stopped the Target; no exit is retried under it. */
  intent: "running" | "stopped";
  /** The latest process Rig started; exit evidence that names another one is not evidence about this Service. */
  incarnation?: string;
  /** Unix milliseconds of the automatic attempts since the last explicit start. */
  attempts: number[];
  outcome?: ServiceOutcome;
  /** Unix milliseconds before which the next automatic attempt must not start. */
  retryAt?: number;
  /** Five automatic attempts ran within a minute; only an explicit start or a new Deployment starts the Service again. */
  exhausted?: true;
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
  /** Per managed Service name. A Service without a record was never started by this runtime. */
  services?: Record<string, ServiceRun>;
  /** A rolled-back deployment attempt of this source left a build whose outcome is unknown. */
  uncertainBuild?: { branch?: string; commit?: string; unit: string };
  /** Revision of the rig.yaml a Working copy plan was made from. */
  configRevision?: string;
  /** Set by the configuration cutover on a saved Deployment whose old behavior the converted plan cannot reproduce. */
  conversion?: { needsDeploy: string[] };
  recovery?: {
    plan: TargetPlan;
    /** Build outcomes of the plan restored by rollback. */
    preparation?: Preparation;
    branch?: string;
    commit?: string;
    desired: "running" | "stopped";
    /** Completion state of the plan restored by rollback. */
    deploymentIncomplete?: true;
    /** The conversion marker of the plan restored by rollback. */
    conversion?: { needsDeploy: string[] };
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
  version: 4;
  projects: ProjectRecord[];
  targets: TargetRecord[];
  activity: OperationRecord[];
}

export interface StateStore {
  read(): Promise<RuntimeState>;
  /** One daemon owns writes. Updates are serialized and committed atomically. */
  update(change: (state: RuntimeState) => void | Promise<void>): Promise<void>;
}
