/** What an Operation is doing at the moment. `stopping` covers waiting for a Service to exit, which
 * is what `rig status` shows as a stopping Target. */
export type OperationPhase =
  | "starting"
  | "stopping"
  | "restarting"
  | "deploying"
  | "destroying"
  | "registering"
  | "renaming"
  | "repointing"
  | "forgetting"
  | "editing config"
  | "reconciling"
  | "supervising"
  | "preparing to uninstall";

/** One Service an Operation asked to stop, as the waiting command and `rig status` show it. */
export interface ServiceStopView {
  service: string;
  /** The Target the Service belongs to. */
  target: string;
  /** `stopping` until the Service's process is gone; `failed` when its stop could not be verified. */
  state: "stopping" | "stopped" | "failed";
  /** When the stop signal was sent (ISO 8601). */
  since: string;
  /** When SIGKILL is due (ISO 8601): the stop_timeout after `since`, or the kill wait after a kill was asked. */
  killAt: string;
  /** When the process was gone (ISO 8601). */
  endedAt?: string;
  /** The process needed SIGKILL: its stop_timeout ran out, or a kill cut it short. */
  killed?: "timeout" | "request";
}

/** One Operation rigd is running or holding in its queue, as a waiting command names it. */
export interface OperationView {
  operationId: string;
  /** The command action, or `reconcile`/`supervise` for rigd's own passes. */
  action: string;
  project?: string;
  target?: string;
  phase: OperationPhase;
  startedAt: string;
  /** The Services this Operation has asked to stop so far, in the order it asked; absent before its first stop. */
  stops?: ServiceStopView[];
}

/** Where one Operation stands: running, waiting behind the Operations named in `waitingOn` (and
 * `ahead` more queued before it on the same Target or Project), or unknown to rigd. */
export type OperationPosition =
  | {
      state: "running";
      phase: OperationPhase;
      project?: string;
      target?: string;
      stops?: ServiceStopView[];
    }
  | { state: "waiting"; waitingOn: OperationView[]; ahead: number }
  | { state: "unknown" };

/** The `queue` read. `running` is the longest-running command (not rigd's own supervision) and `waiting` how many wait; both
 * kept for readers written when rigd ran one Operation at a time. */
export interface QueueReport {
  running?: OperationView;
  waiting: number;
  operations: OperationView[];
  operation?: OperationPosition;
}

const ACTION_PHASE: Record<string, OperationPhase> = {
  up: "starting",
  down: "stopping",
  restart: "restarting",
  deploy: "deploying",
  destroy: "destroying",
  init: "registering",
  rename: "renaming",
  repoint: "repointing",
  forget: "forgetting",
  "prepare-uninstall": "preparing to uninstall",
  reconcile: "reconciling",
  supervise: "supervising",
};

/** The phase an Operation starts in. */
export function initialPhase(action: string): OperationPhase {
  return ACTION_PHASE[action] ?? "starting";
}
