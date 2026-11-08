import type { ProcessRecord } from "./process-identity";

/** How rigd is started and stopped in one login install mode: a detached process, or a LaunchAgent. */
export interface DaemonLauncher {
  /** Starts rigd from the installed command. */
  start(): Promise<void>;
  /** Stops the serving rigd `pid` without waiting for it to exit; fails as the mode's mechanism fails. */
  stop(pid: number): Promise<void>;
  /** Stops a rigd that does not answer. A process is signalled only when `alive` names it, and a failed signal is ignored;
   * a LaunchAgent that launchd does not know counts as stopped. */
  stopUnreachable(alive: () => Promise<ProcessRecord[]>): Promise<void>;
  /** Keeps a rigd that refused to start from being started again; failures are ignored. */
  abandon(): Promise<void>;
  /** Removes what would start rigd again at the next login. */
  discard(): Promise<void>;
}
