import type { TargetPlan } from "../config/types";
import type { HostRestart, HostSession } from "./host-session";
import type { AlertState } from "./operator-alerts";
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
      /** Who saw the end when the application's own exit record was missing: launchd's record of the job that ran its
       * capture wrapper, or rigd's record of the wrapper it spawned. Absent when the application's own record said. */
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
  /** Digest of what that rig.yaml said, whatever its format, comments or layout; absent on a Target an older rigd planned. */
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

export interface RuntimeState {
  version: 4;
  projects: ProjectRecord[];
  targets: TargetRecord[];
  activity: OperationRecord[];
  /** The boot and login session rigd last acted on; absent until a rigd that records it has started. */
  host?: HostSession & {
    seenAt: string;
    /** A Host restart rigd found but has not finished acting on, recorded in Activity unless `unannounced`, and the boot and
     * login it found then; a daemon that finds the same restart again acts on it without recording it twice. */
    restart?: {
      kind: HostRestart;
      boot?: string;
      login?: string;
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
  /** Stable Targets Rig counts as down and what the operator was alerted about; absent until the first alert evaluation. */
  alerts?: AlertState;
}

export interface StateStore {
  read(): Promise<RuntimeState>;
  /** One daemon owns writes. Updates are serialized and committed atomically. */
  update(change: (state: RuntimeState) => void | Promise<void>): Promise<void>;
}
