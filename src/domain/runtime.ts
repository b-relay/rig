import type { TargetPlan } from "../config/types";
import type { TargetRole } from "../config/schema";
import type { HostRestart, HostSession } from "./host-session";
import type { OperationOutcome } from "./activity";

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
  | {
      kind: "exited";
      exitCode?: number;
      signal?: string;
      /** Who saw the end when the application's own exit record was missing: rigd's record of the wrapper it spawned, or,
       * in outcomes recorded by Rig versions that offered launchd supervision, launchd's record of the job that ran its
       * capture wrapper. Absent when the application's own record said. */
      recordedBy?: "launchd" | "rigd";
      at: string;
    }
  /** A start could not be verified and its process was stopped: `activation-failed` for an automatic attempt, which counts
   * as a failure to retry, `start-failed` for an operator's own start, which is theirs to repeat. */
  | {
      kind: "activation-failed" | "start-failed";
      errorCode: string;
      at: string;
    }
  /** `hostRestart` says the process is gone because the Host restarted or the user logged out, as rigd detected at its
   * next start; nothing starts such a Service of the Working copy or a Preview again before an explicit start. */
  | { kind: "unknown"; hostRestart?: HostRestart; at: string };
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
  /** Unix milliseconds of the automatic attempts made after an unknown exit since the last explicit start: a separate,
   * slower budget than `attempts`. */
  unknownAttempts?: number[];
  outcome?: ServiceOutcome;
  /** Unix milliseconds before which the next automatic attempt must not start. */
  retryAt?: number;
  /** A due automatic attempt was held back without spending budget: a Service it depends on is not running, or, after an
   * unknown exit, one of its ports still accepts connections. */
  waitingFor?: { service: string } | { ports: number[] };
  /** The process now running was started automatically after an unknown exit. */
  restartedAfterUnknown?: true;
  /** The process now running was started by rigd after it detected this Host restart. */
  startedAfterHostRestart?: HostRestart;
  /** The automatic attempts of the budget the latest outcome draws on are used up; only an explicit start or a new Deployment
   * starts the Service again. */
  exhausted?: true;
  /** The operator's latest stop needed SIGKILL: the stop_timeout ran out (`timeout`), or `--kill` cut it short (`request`).
   * A new start clears it. */
  stopKilled?: "timeout" | "request";
  /** The unhealthy stretch a health restart started this process in: when the Service became unhealthy and each health
   * restart since (Unix milliseconds), so a new rigd continues the back-off. Automatic starts carry it on; an explicit start
   * clears it. `pendingStart` is when the latest health restart began, written before it stopped anything and cleared once
   * its start passed: until then the health monitor owns the Service, checking it while a process runs and starting it at
   * the next step of the back-off while none does, not automatic restart. */
  healthStretch?: { since: number; restarts: number[]; pendingStart?: number };
  /** Where this start falls in the order of starts and Host restarts (`RuntimeState.startSeq`). A stop by a Host restart
   * applies only to a run started before the restart was recorded; one without it was started by an older rigd and counts
   * as before. */
  startSeq?: number;
}

export interface TargetRecord {
  id: string;
  projectId: string;
  name: string;
  kind: TargetRole;
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
  /** Digest of what that rig.yaml said, whatever its comments or layout; absent on a Target an older rigd planned. */
  configDigest?: string;
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
  outcome: OperationOutcome;
  occurredAt: string;
  message?: string;
}

/** One deploy rigd attempted, with the source it deployed and how it ended; the dashboard's deploy history and rollback read it. */
export interface DeploymentRecord {
  /** The deploy's Operation id, as in Activity. */
  id: string;
  projectId: string;
  project: string;
  /** The Target's name: `stable` or the Preview's name. */
  target: string;
  kind: "stable" | "preview";
  branch?: string;
  /** The Commit deployed, or the one asked for when the deploy failed after resolving it. */
  commit?: string;
  /** The Commit the Target ran before, when it had one. */
  previousCommit?: string;
  outcome: "deployed" | "unchanged" | "failed";
  startedAt: string;
  finishedAt: string;
  /** The failure's error code; never a value from the environment. */
  message?: string;
}
/** How a job run ended: exit 0, another exit or a signal, stopped at its timeout, stopped by Rig (rig down, a restart or a
 * deploy), gone with nothing recording how (the Mac restarted, or its exit record was lost), or never started. */
export type JobOutcome =
  "succeeded" | "failed" | "timed-out" | "stopped" | "unknown" | "start-failed";
/** One run of a scheduled job. */
export interface JobRun {
  /** The run's identity: the incarnation its process carries, and the id of its Activity entries. */
  id: string;
  trigger: "schedule" | "manual";
  /** The scheduled time a scheduled run is for (ISO 8601). */
  scheduledFor?: string;
  startedAt: string;
  /** The checkout the run started in (its plan's workspacePath). A deploy keeps it until the run ends. */
  workspace?: string;
  /** Seconds the run may take before it is stopped as timed out, as its plan said when it started; absent: no limit. */
  timeout?: number;
  /** Seconds the run may take to exit after SIGTERM, as its plan said when it started; absent means the 10 s default. */
  stopTimeout?: number;
  finishedAt?: string;
  outcome?: JobOutcome;
  exitCode?: number;
  signal?: string;
  /** Why the start failed, as the error code Rig reported. */
  errorCode?: string;
  /** Scheduled times skipped because this run was still going. */
  skipped?: number;
  /** Rig decided to stop the run, and why: written before the stop signal, so a rigd that restarts before the end is
   * recorded still records it as stopped by Rig or timed out. */
  stopping?: { cause: "stopped" | "timed-out"; at: string };
}
/** What rigd knows about one job of one Target. Kept apart from the Target record, so an Operation that saves its Target
 * never replaces what the job runner recorded meanwhile. */
export interface JobRecord {
  /** The Target's id. */
  target: string;
  /** The job's name. */
  job: string;
  /** The run in progress, recorded before its process is started. */
  running?: JobRun;
  /** The latest run that ended. */
  last?: JobRun;
  /** The latest scheduled time rigd acted on, by running, skipping or passing over it (ISO 8601). */
  lastScheduled?: string;
  /** When rigd first saw the job in this Target's plan (ISO 8601), so a time due after it that a rigd restart missed still
   * runs within the late limit, before any time was acted on. */
  watchedFrom?: string;
}
/** A checkout a job run kept after a deploy, to give back once nothing uses it. Recorded with the run's end, in the same
 * write, so a rigd that stops before giving it back finds it again. */
export interface JobCheckout {
  /** The Target's id. */
  target: string;
  /** The Project's id, for a Target removed meanwhile. */
  project: string;
  /** The checkout's absolute path. */
  workspace: string;
}

export interface RuntimeState {
  version: 6;
  projects: ProjectRecord[];
  targets: TargetRecord[];
  activity: OperationRecord[];
  /** Deploys, oldest first, bounded; absent until a rigd that records them has deployed. */
  deployments?: DeploymentRecord[];
  /** Job runs per Target and job; absent until a job first ran or was scheduled. */
  jobs?: JobRecord[];
  /** Checkouts job runs kept after a deploy, waiting to be given back. */
  jobCheckouts?: JobCheckout[];
  /** The last value handed out to order starts and Host restarts: each journalled start takes the next one as its run's
   * `startSeq`, and a recorded Host restart notes the value it found as its `seq`. It only grows. */
  startSeq?: number;
  /** The boot and login session rigd last acted on; absent until a rigd that records it has started. */
  host?: HostSession & {
    seenAt: string;
    /** A Host restart rigd found but has not finished acting on, recorded in Activity unless `unannounced`, and the boot and
     * login it found then; a daemon that finds the same restart again acts on it without recording it twice. */
    restart?: {
      kind: HostRestart;
      boot?: string;
      login?: string;
      /** `startSeq` when the restart was recorded: a run whose `startSeq` is higher was started after it, and the restart's
       * stop never applies to it. Absent on a restart an older rigd recorded. */
      seq?: number;
      /** The Targets already settled for this restart: Stable Targets started again (or whose start failed), and Working
       * copies and Previews whose stopped Services were recorded as stopped by it. A daemon that finds the restart again
       * does not act on them a second time. */
      settled?: string[];
      /** The restart's Activity entry is not written yet; the daemon that finds it again writes it. */
      unannounced?: true;
      /** Earlier restarts, oldest first, whose Activity entries no daemon could write before this restart was found; their
       * entries are written ahead of this one's. Only an unannounced restart carries any. */
      unannouncedBefore?: {
        kind: HostRestart;
        boot?: string;
        login?: string;
      }[];
    };
  };
}

export interface StateStore {
  read(): Promise<RuntimeState>;
  /** One daemon owns writes. Updates are serialized and committed atomically. */
  update(change: (state: RuntimeState) => void | Promise<void>): Promise<void>;
}
