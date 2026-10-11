import type { ProxyPublication } from "../domain/proxy-publication";
import type { FailureCauses } from "../domain/errors";
import type { ProxyReport, ReportedTarget } from "../adapters/proxy-report";
import type { DnsRecord, DnsZone } from "../domain/dns-records";
import type { HostnameCheck, ServedHostname } from "../domain/dns-hostnames";
import type { DnsRequest } from "../daemon/protocol";
/** What the `dns` read answers (ADR 0018): the zones Rig manages, their records, and where each served hostname points. */
export interface DnsReport {
  /** The provider `proxy.tls.dns` names. */
  readonly provider: string;
  /** This Mac's IPv4 address, when Rig knows it. */
  readonly address?: string;
  /** Where the address came from: `proxy.dns.address`, or Tailscale. */
  readonly addressSource?: "config" | "tailscale";
  /** Zones whose records were read. */
  readonly zones: readonly DnsZone[];
  /** Zones `proxy.dns.zones` names that the token cannot see. */
  readonly unseenZones?: readonly string[];
  /** Zones Rig manages whose records could not be read this time, and why; the rest are reported all the same. */
  readonly unreadableZones?: readonly {
    readonly zone: string;
    readonly code: string;
    readonly message: string;
  }[];
  /** Every record of the zones read, by name and then type. */
  readonly records: readonly DnsRecord[];
  readonly hostnames: readonly HostnameCheck[];
}
export type DnsWriteAction = "dns-create" | "dns-update" | "dns-delete";
/** A checked DNS write, ready to make. Neither text holds any credential. */
export interface PreparedDnsWrite {
  readonly zone: string;
  /** The change asked for, as Activity records it whatever the outcome: `create A app.example.com -> 100.64.0.1`. */
  readonly change: string;
  /** What was done, for the reply: `created A app.example.com -> 100.64.0.1`. */
  readonly summary: string;
  /** Makes the change. A write whose answer is lost (a timeout) is checked by reading the record again, so a change
   * Cloudflare made is reported as made. */
  apply(): Promise<DnsRecord | undefined>;
}
/** DNS record management as rigd's runtime asks for it (ADR 0018). */
export interface DnsControl {
  read(input: {
    readonly zone?: string;
    /** Every hostname a Target serves; `proxy.routes` is added from Host config. */
    readonly hostnames: readonly ServedHostname[];
  }): Promise<DnsReport>;
  /** Validates one write and checks it against the records as they are now: an update or delete of a record whose
   * `modifiedOn` changed since the caller read it, or a create that expects no record where one now is, is refused as
   * DNS_CHANGED. Call it while holding the zone's lock and `apply` straight after. */
  prepare(
    action: DnsWriteAction,
    request: DnsRequest,
  ): Promise<PreparedDnsWrite>;
}
/** What the runtime asks of Rig's own Caddy beyond routing, which goes through the Router. */
export interface ProxyControl {
  /** The job and every served site, Rig's and the owner's proxy.routes, for `rig proxy`. */
  report(targets: readonly ReportedTarget[]): Promise<ProxyReport>;
  /** Publishes the proxy section of Host config as it is now, proxy.routes included (`rig proxy reload`). */
  apply(): Promise<void>;
}
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
import type { LogFilter } from "../domain/log-filter";
import type { TargetLifecycle } from "./lifecycle";
import type { ObservationEffects } from "./status";
import type { ObservationDeadline } from "./bounded-observations";
import type { PortReservations } from "./host-reservations";
import type { HostSessionProbe } from "../domain/host-session";
import type { HealthResults } from "./health-monitor";
import type { HealthTransitions } from "./health-transitions";
export interface ProjectDocuments {
  /** The nearest config at or above `path` inside its Git working repository; a path in a linked
   * worktree is searched from the same place in the main working tree, so it finds the Project its
   * main checkout registers. A directory that is not a repository is searched alone and reported with `gitRequired`. */
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
  /** Whether any tracked file `paths` match changed between the Commits `from` and `to` in `repository`, read from the local
   * repository only, never fetched (ADR 0016). `paths` are pathspecs relative to the repository root (paths, directories,
   * or globs with `*` and `**`); absent means the whole tree, and an empty list matches nothing, so nothing changed.
   * Rejects GIT_DIFF when it cannot tell, as for a Commit that was garbage-collected; a caller counts that as changed. */
  changed(request: {
    repository: string;
    from: string;
    to: string;
    paths?: readonly string[];
  }): Promise<boolean>;
  /** The entries of `paths` (pathspecs as for `changed`) that match no tracked file at the Commit `commit` in `repository`,
   * in their order: a mistyped `watch` entry that would let a deploy keep a stale Service. Rejects GIT_DIFF when it cannot
   * tell. */
  unmatched(request: {
    repository: string;
    commit: string;
    paths: readonly string[];
  }): Promise<string[]>;
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
  /** The newest `lines` entries `filter` keeps, or with `after` the next ones past that cursor; see `readTargetLogs`. */
  logs(
    target: TargetRecord,
    after: string | undefined,
    lines: number,
    filter?: LogFilter,
  ): Promise<{ entries: TargetLogEntry[]; cursor: string }>;
}
/** Whose backups a directory holds: names, as the backup directory tree is laid out. */
export interface BackupScope {
  project: string;
  target: string;
  job: string;
}
/** Where backups live on the Mac (ADR 0017). Every path must be one `location` gave; anything outside the backup root fails
 * BACKUP_PATH untouched, and so does any path below a symlinked or non-directory component between the root and it.
 * Nothing inside a backup is opened or followed, and no mode is changed after a directory is made. */
export interface BackupStorage {
  /** Pure: the directory of the backup `id` of `scope`; not created. */
  location(scope: BackupScope, id: string): string;
  /** Creates `path` fresh and empty, mode 0700, with its parents; fails BACKUP_DIRECTORY when it exists or cannot be made,
   * BACKUP_PATH when a directory on the way is a symlink. */
  create(path: string): Promise<void>;
  /** Whether `path` is a real directory now, reached through real directories only. */
  exists(path: string): Promise<boolean>;
  /** Total bytes under `path`, every entry by its own lstat size; undefined when it is gone or not reachable safely. */
  measure(path: string): Promise<number | undefined>;
  /** Deletes `path` without following any symlink, and its empty parents up to the backup root: `removed`, also when it was
   * already gone; `skipped`, touching nothing, when a directory on the way is a symlink. Fails BACKUP_REMOVE. */
  remove(path: string): Promise<"removed" | "skipped">;
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
  /** Whether the route file lies inside the Rig root (through any symlink), so no other Rig root can own a block in it.
   * Only then does rigd withdraw route blocks no recorded Target owns on its own (at start, before a deploy, up or
   * restart); otherwise only `rig proxy reload` does, and doctor says another root may own them. Absent: inside. */
  routeFileInRoot?(): Promise<boolean>;
  /** Rig's own Caddy, when Host config has a proxy section (ADR 0014); absent otherwise. */
  proxy?: ProxyControl;
  /** DNS record management (ADR 0018); absent where rigd offers none, as in most tests. */
  dns?: DnsControl;
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
  /** Backup directories under RIG_ROOT/backups. Absent where no job keeps backups, as in tests that run none; a backup job
   * then fails BACKUP_UNAVAILABLE. */
  backups?: BackupStorage;
  /** The running Operation's port claims. Present while an Operation plans, so ports it chose but has
   * not recorded yet are never handed to an Operation running beside it; absent, planning sees only
   * the recorded Targets. */
  ports?: PortReservations;
  /** How long a supervision pass waits for the Targets it is working on before it returns. The work
   * carries on under each Target's own lease and a later pass reads its outcome, so one slow restart
   * or stop never holds up the next pass. Absent, a pass waits for all of it. */
  supervisionPassBudget?: { ms: number; deadline: ObservationDeadline };
  /** Reads the Host's boot and login session, which the daemon's first pass compares with the one it last recorded to
   * tell a Host restart from a plain daemon restart. Absent, no Host restart is ever detected. */
  hostSession?: HostSessionProbe;
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
  /** The health monitor's cached results of ongoing checks, which status and doctor read instead of running them; absent
   * where no monitor runs. */
  healthResults?: HealthResults;
  /** Where every state write that is a lifecycle transition (a plan, desired state, recovery or destruction change, a
   * removed Target, a Service's new process) is reported to the health monitor, as it is applied; absent where no monitor
   * runs. */
  healthTransitions?: HealthTransitions;
  /** The Host's IANA time zone, which schedules a job without `timezone`; the system's own when absent. */
  timeZone?(): string;
  /** Whether the runtime may start Services before its first pass has read the state: `closed` (the default, and what rigd
   * uses) until one has; `open` only for a runtime that is never reconciled, as in tests. */
  reconcileGate?: "closed" | "open";
}

/** Borrowed inventory snapshot under the runtime mutation queue. */
export interface PreviewDeletion {
  root: string;
  target: TargetRecord;
  state: Pick<import("../domain/runtime").RuntimeState, "projects" | "targets">;
}
