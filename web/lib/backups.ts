import { targetSelector } from "./target";
import type { JobReport, RuntimeCommand, TargetReport } from "./types";
import type { BackupReport } from "../../src/daemon/protocol";
export { formatBytes } from "../../src/domain/bytes";

/* Backups (`backup:` on a job in rig.yaml, `rig backup list` and `rig backup restore`, ADR 0017) as the `backups` read lists
 * them and each backup job's status reports them (`targets[].jobs[].backup`). */

export type BackupView = BackupReport;

/** Pure: `job`'s backups in `target`, newest first, from a Project's backup list. */
export function backupsOf(
  backups: readonly BackupView[],
  target: Pick<TargetReport, "name">,
  job: string,
): BackupView[] {
  return backups
    .filter((backup) => backup.target === target.name && backup.job === job)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}
/** Pure: whether `job` keeps backups, so its card offers Back up now and its list. */
export function isBackupJob(job: Pick<JobReport, "backup">): boolean {
  return job.backup !== undefined;
}
/** Pure: why Restore cannot put `backup` back now, or undefined when it can: not without a restore command, not while
 * a run or restore of the job goes, and not when the backup's directory is gone. */
export function restoreBlocked(
  job: Pick<JobReport, "name" | "state" | "backup" | "removed">,
  backup: Pick<BackupView, "missing">,
): string | undefined {
  if (job.removed) return "This job is no longer in rig.yaml.";
  if (!job.backup?.restore)
    return `${job.name} has no restore command: add backup.restore to it in rig.yaml.`;
  if (job.state === "running")
    return `${job.name} is running; a restore never overlaps a run of it.`;
  if (backup.missing) return "This backup's directory is gone.";
  return undefined;
}
/** Pure: whether what was typed confirms a restore of `job`: its name exactly. */
export function restoreConfirmed(typed: string, job: string): boolean {
  return typed.trim() === job;
}
/** Pure: the command that restores `backup` of `job` in `target`, as `rig backup restore <job> <id> <target>` sends it. */
export function restoreCommand(
  project: string,
  target: Pick<TargetReport, "kind" | "name">,
  job: string,
  backup: string,
): RuntimeCommand {
  return {
    action: "restore",
    project,
    ...targetSelector(target),
    job,
    backup,
  };
}
