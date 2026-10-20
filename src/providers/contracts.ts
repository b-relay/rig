import type { DnsRecord, DnsRecordInput, DnsZone } from "../domain/dns-records";

/** Providers own external effects; runtime chooses policy and supplies resolved inputs. */
export interface ManagedProcess {
  readonly key: string;
  readonly componentName: string;
  readonly command: readonly string[];
  readonly cwd: string;
  /** When set, `cwd` must resolve inside this directory, symlinks followed: the start fails WORKING_DIR_OUTSIDE otherwise. */
  readonly cwdWithin?: string;
  /** Used to spawn the process and never written to disk: a later start is given a freshly composed environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly logRoot: string;
  /** The caller's name for this one process; every observation of it, running or exited, carries it back. */
  readonly incarnation: string;
  /** How long the process may take to exit after SIGTERM before SIGKILL, in milliseconds: its Service's stop_timeout. It is
   * written into the capture request, so the capture wrapper holds the same grace as the stop. Absent: the 10 s default. */
  readonly stopGraceMs?: number;
}
/** How one stop waits. */
export interface StopRequest {
  /** How long the process may take to exit after SIGTERM before SIGKILL, in milliseconds: its Service's stop_timeout. */
  readonly graceMs: number;
  /** Aborted before or during the stop, it cuts what is left of the grace to the kill wait: SIGKILL follows then. */
  readonly kill?: AbortSignal;
  /** Aborted, it ends the wait at once: the stop fails STOP_DETACHED and the process finishes stopping on its own, still
   * owned, for the next stop to find. rigd's shutdown uses it so it never waits out a long grace. */
  readonly detach?: AbortSignal;
}
/** How a stop ended. `killed` says the process needed SIGKILL: because its grace ran out (`timeout`), or because a kill cut
 * the grace short (`request`). Absent when it exited within its grace or was not running. */
export interface StopResult {
  readonly outcome: "stopped" | "unchanged";
  readonly killed?: StopKill;
}
export type StopKill = "timeout" | "request";
/** How a start that fails after it spawned its process stops that process, and who hears about it. A supervisor stops what
 * a failed start spawned within the start's grace, like any stop, before the start fails. */
export interface StartControl {
  /** Aborted before or during that stop, it cuts the rest of the grace to the kill wait: `rig down --kill`. */
  readonly kill?: AbortSignal;
  /** Hears that stop begin, with the grace it waits, and end, so the Operation can show it as stopping. */
  readonly observer?: StartCleanupObserver;
}
export interface StartCleanupObserver {
  stopping(graceMs: number): void;
  /** How the stop ended; `failed` when it could not finish, STOP_DETACHED included. */
  stopped(ended: StopResult | { readonly outcome: "failed" }): void;
}
/** A supervisor starts a process once and never starts it again on its own: whether an exit is retried is the runtime's decision.
 * `stopped` means no process of the start runs any more: under a capture wrapper, neither the wrapper nor the application it
 * last reported; one that may still run is `unknown`. A stopped observation with `exitCode` or `signal` is recorded evidence of
 * how `incarnation` ended. Without either, how the process ended is unknown: it was stopped on request, never started, or its
 * evidence is gone. */
export interface ProcessObservation {
  readonly state: "running" | "stopped" | "unknown";
  readonly pid?: number;
  readonly incarnation?: string;
  readonly exitCode?: number;
  /** The signal that ended the process when it did not exit by itself. */
  readonly signal?: string;
  /** Who recorded the exit when the application's own exit record is missing: `rigd` for its record of the capture wrapper
   * it spawned. The wrapper stops its application before it ends and ends by the signal that stopped it, so its end describes
   * the application's. Absent for the application's own record. */
  readonly recordedBy?: ExitWitness;
  readonly reason?: string;
}
/** Who saw a capture wrapper end when its application's own exit record is missing. */
export type ExitWitness = "rigd";
/** One readiness probe. A failed probe carries what was observed: an HTTP status, a connection error, or a command's exit code and last output line. */
export type HealthCheck =
  { readonly ready: true } | { readonly ready: false; readonly reason: string };
export interface Supervisor {
  /** Starts `request` unless it runs. A start that fails after it spawned something stops that first, as `control` says;
   * it fails STOP_DETACHED instead when rigd's shutdown ends that stop's wait, and the process finishes stopping on its own. */
  ensureRunning(
    request: ManagedProcess,
    control?: StartControl,
  ): Promise<{ outcome: "started" | "unchanged"; pid?: number }>;
  /** SIGTERM, then SIGKILL once the request's grace has passed (sooner after a kill: once the kill wait has). Fails
   * STOP_DETACHED when `detach` aborts first. */
  stop(key: string, request: StopRequest): Promise<StopResult>;
  observe(key: string, signal?: AbortSignal): Promise<ProcessObservation>;
  /** Stops every owned process; used when the Host must end with nothing running. */
  shutdown(): Promise<void>;
  /** Releases in-memory ownership and leaves processes running; recorded leases let the next daemon adopt them. */
  detach(): Promise<void>;
  /** Records `pid`, the process group of a command rigd runs itself under `key` (a build), as a lease before it resolves,
   * so `observe` and `stop` find the group even after the daemon that ran it died. The group counts as running while any
   * of its members does, its leader gone or not. Rejects, recording nothing, when the group is already gone. Absent: such a
   * command is not recorded. */
  own?(key: string, pid: number): Promise<void>;
  /** Once its command has ended, stops what is left of the group `own` recorded for `key` (a process the command started in
   * the background) within the default grace, then forgets it. Fails, keeping the record, when the group cannot be stopped. */
  disown?(key: string): Promise<void>;
}
export interface CommandRequest {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Receives each chunk of output as the command produces it; the result still carries the bounded whole. */
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Told the pid of the command's process group once it is spawned and before the command runs: the command waits at a
   * gate until this resolves, so the group can be recorded first, and ends without running when it rejects, which the
   * command then rejects with. With it, an executable that cannot start ends with the shell's 126 or 127 rather than
   * COMMAND_START. */
  readonly started?: (pid: number) => Promise<void>;
}
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The command was killed at its budget: exitCode is 1 and the streams hold what it produced before then. */
  readonly timedOut?: true;
  /** The streams that printed more than the runner keeps, so their text starts partway through what was printed. */
  readonly truncated?: { readonly stdout?: true; readonly stderr?: true };
}
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;
export interface TargetLogEntry {
  readonly timestamp: string;
  readonly component: string;
  /** health lines are readiness probe evidence written when the observation changes. */
  readonly stream: "stdout" | "stderr" | "health" | "unknown";
  readonly line: string;
}
/** A DNS provider's records API in Rig's own terms (ADR 0018): the zones its credentials can see and their records. Every
 * failure is a RigError whose message, hint and details never hold the credentials. */
export interface DnsProvider {
  /** Every zone the credentials can see. */
  zones(): Promise<DnsZone[]>;
  /** Every record of `zone`, all pages read. */
  records(zone: DnsZone): Promise<DnsRecord[]>;
  /** One record as it is now, or undefined when it no longer exists. */
  record(zone: DnsZone, id: string): Promise<DnsRecord | undefined>;
  create(zone: DnsZone, record: DnsRecordInput): Promise<DnsRecord>;
  /** The record as written, or undefined when it no longer exists. */
  update(
    zone: DnsZone,
    id: string,
    record: DnsRecordInput,
  ): Promise<DnsRecord | undefined>;
  /** False when the record no longer existed. */
  delete(zone: DnsZone, id: string): Promise<boolean>;
}
/** The address other machines reach this Mac at, which "Point at this Mac" writes into an A record. */
export interface HostAddress {
  /** This Mac's IPv4 address, or undefined when it cannot be found. */
  ipv4(): Promise<string | undefined>;
}
