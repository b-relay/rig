import type { PlanJob } from "../config/types";
import { RigError, diagnosticErrorCode } from "../domain/errors";
import type {
  BackupRecord,
  JobRun,
  RuntimeState,
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import type { BackupReport } from "../daemon/protocol";
import type { BackupSummaryReport } from "../domain/project-status";
import type {
  BackupScope,
  BackupStorage,
  RuntimeDependencies,
} from "./contracts";

/* Backups (ADR 0017): a run of a job with `backup:` writes a fresh directory; a successful one is kept and counted against the job's `keep`; anything else the run made is deleted. Every deletion is queued in the state (`backupRemovals`)
 * in the write that decides it, then carried out, so a rigd that stops in between finds it and nothing Rig did not record
 * making is ever deleted. */

/** What `rig backup restore` takes instead of an id: the newest backup. */
export const LATEST_BACKUP = "latest";

/** What backup bookkeeping needs from the runtime. */
export interface BackupDependencies {
  store: Pick<StateStore, "read" | "update">;
  /** Absent where no job keeps backups, as in most tests; a backup job then fails BACKUP_UNAVAILABLE. */
  backups?: BackupStorage;
  diagnostic?: RuntimeDependencies["diagnostic"];
  id?(): string;
}

/** Pure: `20261011T030000Z` for the ISO instant `at`. */
export function backupStamp(at: string): string {
  return new Date(at)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}
/** Pure: the backups of `job` of the Target `targetId`, newest first. */
export function jobBackups(
  state: Pick<RuntimeState, "backups">,
  targetId: string,
  job: string,
): BackupRecord[] {
  return newestFirst(
    (state.backups ?? []).filter(
      (backup) => backup.target === targetId && backup.job === job,
    ),
  );
}
/** Pure: one job's backups of one Target, given in the inventory's order, newest first. Never by time, which a clock set
 * back or forward would reorder: a backup this Rig recorded carries its `sequence`, which follows the order its job's runs
 * were recorded in; one an older Rig recorded carries none, and is older than every one that does, the later in the
 * inventory (which adds each backup as its run ends) the newer. The number in an older id is not used: the first writer
 * numbered only backups made within one second. */
function newestFirst(backups: readonly BackupRecord[]): BackupRecord[] {
  const rank = (backup: BackupRecord, position: number) =>
    backup.sequence !== undefined ? [1, backup.sequence] : [0, position];
  return backups
    .map((backup, position) => ({ backup, rank: rank(backup, position) }))
    .sort((a, b) => b.rank[0]! - a.rank[0]! || b.rank[1]! - a.rank[1]!)
    .map(({ backup }) => backup);
}
/** Pure: which of `backups` (one job's, of one Target, newest first as `jobBackups` gives them) leave so that only the
 * newest `keep` stay, the backup `fresh` always among them. */
export function expiredBackups(
  backups: readonly BackupRecord[],
  keep: number,
  fresh: string,
): BackupRecord[] {
  return backups
    .filter((backup) => backup.id !== fresh)
    .slice(Math.max(0, keep - 1));
}

/** Pure: a backup id, `<UTC second>-<sequence>`, such as `20261011T030000Z-17`. */
export function backupId(startedAt: string, sequence: number): string {
  return `${backupStamp(startedAt)}-${sequence}`;
}
/** Pure: the sequence number in a backup id; undefined for an id of another shape. */
function sequenceOf(id: string): number | undefined {
  const match = /-([1-9]\d*)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

/** Allocates the directory a new run of `job` on `target` writes, inside the state write that records the run before the
 * directory is made, so no two runs, and no rigd that stops in between, are ever handed the same one. Its id is the run's
 * UTC second and the next number of the job's backup sequence, which only ever grows.
 *
 * The sequence is kept per backup directory, `<project>/<target>/<job>` by name (`backupSequences`), and is never reset or
 * forgotten: not when its backups are deleted, not by a Preview destroy or `rig forget`, so a Preview made again under the
 * same name, or a Project registered again, continues it. Names that differ only in case share one sequence, as they share
 * one directory on the Mac's case-insensitive disk, so two Projects named so never get the same path. It also starts past
 * every number the Target's kept backups of the job carry, so a Project renamed while it has backups never repeats one. A
 * backup id is therefore never issued twice for a Target's job, its number (kept as the run's and the backup's `sequence`)
 * orders its backups, and naming one can only ever find the backup it was issued to, or nothing. */
export function allocateBackup(
  state: RuntimeState,
  target: Pick<TargetRecord, "id" | "projectId" | "name">,
  job: string,
  startedAt: string,
  storage: Pick<BackupStorage, "location">,
): { id: string; path: string; sequence: number } {
  const project =
    state.projects.find((p) => p.id === target.projectId)?.name ??
    target.projectId;
  const scope = { project, target: target.name, job };
  const counters = (state.backupSequences ?? []).filter((sequence) =>
    sameDirectory(sequence, scope),
  );
  const kept = jobBackups(state, target.id, job).map(
    (backup) => sequenceOf(backup.id) ?? 0,
  );
  const next =
    Math.max(...counters.map((counter) => counter.last), ...kept, 0) + 1;
  for (const counter of counters) counter.last = next;
  if (!counters.length)
    (state.backupSequences ??= []).push({ ...scope, last: next });
  const id = backupId(startedAt, next);
  return { id, path: storage.location(scope, id), sequence: next };
}
/** Pure: whether two backup scopes name one directory on a case-insensitive disk, as the Mac's is. */
function sameDirectory(a: BackupScope, b: BackupScope): boolean {
  const folded = (scope: BackupScope) =>
    [scope.project, scope.target, scope.job].join("/").toLowerCase();
  return folded(a) === folded(b);
}

/** Records, inside the write that records the end of `run`, what becomes of the directory it wrote: a successful run's is
 * a backup, and the job's backups past the `keep` the run started with (never this one) are queued for deletion; any other
 * end, or a success that left no directory (`lost`), queues the run's own path for deletion when the run made it (see
 * `madeBackupDirectory`), leaves it in place otherwise, and leaves every backup alone. Resolves the new backup, if one was
 * kept. A run that wrote no backup changes nothing. */
export function recordBackupEnd(
  state: RuntimeState,
  target: Pick<TargetRecord, "id" | "projectId">,
  job: string,
  run: JobRun,
): BackupRecord | undefined {
  const made = run.backup;
  if (!made) return undefined;
  if (run.outcome !== "succeeded" || made.lost) {
    if (madeBackupDirectory(run)) queueRemoval(state, target, made.path);
    return undefined;
  }
  const backup: BackupRecord = {
    target: target.id,
    project: target.projectId,
    job,
    id: made.id,
    path: made.path,
    run: run.id,
    trigger: run.trigger === "schedule" ? "schedule" : "manual",
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? run.startedAt,
    ...(made.sequence !== undefined ? { sequence: made.sequence } : {}),
  };
  (state.backups ??= []).push(backup);
  const expired = expiredBackups(
    jobBackups(state, target.id, job),
    made.keep,
    made.id,
  );
  if (expired.length) {
    state.backups = state.backups.filter((other) => !expired.includes(other));
    for (const old of expired) queueRemoval(state, target, old.path);
  }
  return backup;
}
/** Pure: whether the ended `run` made its backup directory, so that the directory is Rig's to delete. Only a directory the
 * run recorded making is: the path is allocated before it is made, and a run that stopped in between, or found something
 * already there, may name a directory it never made. A run whose process ran made it too, as the process starts only once
 * the directory is made (a run a rigd before this record started). */
export function madeBackupDirectory(run: JobRun): boolean {
  if (!run.backup) return false;
  return (
    run.backup.made === true ||
    (run.outcome !== undefined &&
      run.outcome !== "unknown" &&
      run.outcome !== "start-failed")
  );
}
/** Queues every backup of the Target `targetId` for deletion, as a Preview destroy does in the write that forgets it. */
export function queueTargetBackups(
  state: RuntimeState,
  targetId: string,
): void {
  const leaving = (state.backups ?? []).filter(
    (backup) => backup.target === targetId,
  );
  if (!leaving.length) return;
  state.backups = state.backups!.filter((backup) => backup.target !== targetId);
  for (const backup of leaving)
    queueRemoval(
      state,
      { id: backup.target, projectId: backup.project },
      backup.path,
    );
}
/** Queues `path` for deletion, written once. */
export function queueRemoval(
  state: RuntimeState,
  target: Pick<TargetRecord, "id" | "projectId">,
  path: string,
): void {
  if (state.backupRemovals?.some((removal) => removal.path === path)) return;
  (state.backupRemovals ??= []).push({
    target: target.id,
    project: target.projectId,
    path,
  });
}

/** After the write that recorded a backup run's end: records the new backup's size, then deletes what the write queued.
 * Never rejects: a failure is a diagnostic, and what was not deleted stays queued for the scheduler's next offer. */
export async function settleBackupFiles(
  target: Pick<TargetRecord, "id" | "name">,
  fresh: BackupRecord | undefined,
  deps: BackupDependencies,
): Promise<void> {
  if (!deps.backups) return;
  if (fresh) await measureBackup(fresh, target.name, deps);
  await removeQueuedBackups(deps, target.id);
}
/** Records the size of `backup`. Never rejects: a failure is a diagnostic, and a backup whose size is not recorded is
 * offered again by `tidyBackups`. */
async function measureBackup(
  backup: Pick<BackupRecord, "path">,
  target: string,
  deps: BackupDependencies,
): Promise<void> {
  if (!deps.backups) return;
  try {
    const bytes = await deps.backups.measure(backup.path);
    if (bytes !== undefined)
      await deps.store.update((state) => {
        const recorded = state.backups?.find(
          (other) => other.path === backup.path,
        );
        if (recorded) recorded.bytes = bytes;
      });
  } catch (error) {
    await report(deps, target, "backup-measure", error, backup.path);
  }
}
/** Whether the state holds backup work left to do: directories queued for deletion, or a backup whose size a rigd that
 * stopped right after its run never recorded. */
export function backupWorkPending(
  state: Pick<RuntimeState, "backups" | "backupRemovals">,
): boolean {
  return Boolean(
    state.backupRemovals?.length ||
    state.backups?.some((backup) => backup.bytes === undefined),
  );
}
/** The scheduler's offer: measures every backup left without a size, then deletes every queued directory. Rejects only when
 * the state cannot be read; each backup's own failure is a diagnostic, and offered again. */
export async function tidyBackups(deps: BackupDependencies): Promise<void> {
  if (!deps.backups) return;
  const unsized = ((await deps.store.read()).backups ?? []).filter(
    (backup) => backup.bytes === undefined,
  );
  for (const backup of unsized)
    await measureBackup(backup, backup.target, deps);
  await removeQueuedBackups(deps);
}
/** Deletes the queued directories (of the Target `targetId` only, when given) and forgets each one that is gone. One below a
 * symlinked directory is skipped, never followed, and forgotten with a diagnostic; one that cannot be deleted stays
 * queued, and is a diagnostic. Never rejects. */
export async function removeQueuedBackups(
  deps: BackupDependencies,
  targetId?: string,
): Promise<void> {
  if (!deps.backups) return;
  let queued;
  try {
    queued = ((await deps.store.read()).backupRemovals ?? []).filter(
      (removal) => targetId === undefined || removal.target === targetId,
    );
  } catch {
    return;
  }
  const removed: string[] = [];
  for (const removal of queued)
    try {
      if ((await deps.backups.remove(removal.path)) === "skipped")
        await report(
          deps,
          removal.target,
          "backup-remove",
          undefined,
          removal.path,
          "a directory on the way to it is a symlink, so nothing was deleted",
        );
      removed.push(removal.path);
    } catch (error) {
      await report(deps, removal.target, "backup-remove", error, removal.path);
    }
  if (removed.length)
    await deps.store
      .update((state) => {
        state.backupRemovals = state.backupRemovals?.filter(
          (removal) => !removed.includes(removal.path),
        );
        if (!state.backupRemovals?.length) delete state.backupRemovals;
      })
      .catch(() => {});
}
async function report(
  deps: BackupDependencies,
  target: string,
  action: string,
  error: unknown,
  path: string,
  /** Why something was left in place instead of failing. */
  skipped?: string,
): Promise<void> {
  await deps
    .diagnostic?.({
      operationId: deps.id?.() ?? action,
      action,
      outcome: skipped ? "skipped" : "failed",
      target,
      path,
      ...(skipped
        ? { reason: skipped }
        : { errorCode: diagnosticErrorCode(error) }),
    })
    .catch(() => {});
}

/** The storage a backup job needs, or BACKUP_UNAVAILABLE where this runtime has none. */
export function backupStorage(deps: BackupDependencies): BackupStorage {
  if (deps.backups) return deps.backups;
  throw new RigError(
    "BACKUP_UNAVAILABLE",
    "This rigd has no backup storage, so it cannot run a job that keeps backups.",
    "Run the job under rigd, which keeps backups under RIG_ROOT/backups.",
  );
}

/** Pure: the backup `which` names among `job`'s backups in the Target: `latest` for the newest, else its id. Fails
 * BACKUP_UNKNOWN, naming the ones there are, or naming none when there are none. */
export function selectBackup(
  state: Pick<RuntimeState, "backups">,
  target: Pick<TargetRecord, "id" | "name">,
  job: string,
  which: string,
): BackupRecord {
  const backups = jobBackups(state, target.id, job);
  const found =
    which === LATEST_BACKUP
      ? backups[0]
      : backups.find((backup) => backup.id === which);
  if (found) return found;
  throw new RigError(
    "BACKUP_UNKNOWN",
    backups.length
      ? `${job} on ${target.name} has no backup ${which}.`
      : `${job} on ${target.name} has no backups yet.`,
    backups.length
      ? `Pass latest or one of: ${backups
          .slice(0, 5)
          .map((backup) => backup.id)
          .join(
            ", ",
          )}${backups.length > 5 ? ` (rig backup list ${job} shows all ${backups.length})` : ""}.`
      : `A successful run of ${job} makes one: rig run ${job}.`,
    {
      job,
      backup: which,
      known: backups.map((backup) => backup.id),
    },
  );
}

/** Pure: what status says about `job`'s backups in the Target `targetId`: its keep, whether it can restore, how many there
 * are, their total size and the newest; undefined for a job without `backup`. */
export function backupSummary(
  state: Pick<RuntimeState, "backups">,
  targetId: string,
  job: Pick<PlanJob, "name" | "backup">,
): BackupSummaryReport | undefined {
  if (!job.backup) return undefined;
  const backups = jobBackups(state, targetId, job.name);
  const latest = backups[0];
  return {
    keep: job.backup.keep,
    restore: job.backup.restore !== undefined,
    count: backups.length,
    bytes: backups.reduce((sum, backup) => sum + (backup.bytes ?? 0), 0),
    ...(latest
      ? {
          latest: {
            id: latest.id,
            finishedAt: latest.finishedAt,
            ...(latest.bytes !== undefined ? { bytes: latest.bytes } : {}),
          },
        }
      : {}),
  };
}

/** The kept backups of `targets` (one Project's), narrowed to the Target id `filter.target` and the job `filter.job` when
 * given, as the `backups` read lists them: by Target and job in the order of their names, each job's newest first. Each is
 * checked on disk, and one whose directory is gone is marked `missing`. */
export async function backupReports(
  state: Pick<RuntimeState, "backups">,
  targets: readonly Pick<TargetRecord, "id" | "name">[],
  filter: { target?: string; job?: string },
  deps: Pick<BackupDependencies, "backups">,
): Promise<BackupReport[]> {
  const names = new Map(targets.map((target) => [target.id, target.name]));
  // Newest first, then grouped by a stable sort, so each group keeps that order.
  const listed = newestFirst(
    (state.backups ?? []).filter(
      (backup) =>
        names.has(backup.target) &&
        (filter.target === undefined || backup.target === filter.target) &&
        (filter.job === undefined || backup.job === filter.job),
    ),
  ).sort(
    (a, b) =>
      names.get(a.target)!.localeCompare(names.get(b.target)!) ||
      a.target.localeCompare(b.target) ||
      a.job.localeCompare(b.job),
  );
  return await Promise.all(
    listed.map(async (backup): Promise<BackupReport> => {
      const present = deps.backups
        ? await deps.backups.exists(backup.path).catch(() => false)
        : true;
      return {
        target: names.get(backup.target)!,
        job: backup.job,
        id: backup.id,
        path: backup.path,
        run: backup.run,
        trigger: backup.trigger,
        startedAt: backup.startedAt,
        finishedAt: backup.finishedAt,
        ...(backup.bytes !== undefined ? { bytes: backup.bytes } : {}),
        ...(present ? {} : { missing: true as const }),
      };
    }),
  );
}
