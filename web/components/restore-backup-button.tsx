"use client";

import { useId, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  formatBytes,
  restoreBlocked,
  restoreCommand,
  restoreConfirmed,
  type BackupView,
} from "@/lib/backups";
import { when } from "@/lib/present";
import type { JobReport, TargetReport } from "@/lib/types";
import { Failure } from "./bits";
import { useRun } from "./operations";
import { runRestore } from "@/server/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Puts one backup back, as `rig backup restore <job> <id> <target> --yes` does, once the job's name is typed: the job's
 * restore command runs as a run of the job, with the backup as $RIG_BACKUP_DIR. Rig does not stop the
 * Target's Services. rigd refuses it while a run or restore of the job goes; the refusal shows beneath the button. */
export function RestoreBackupButton({
  project,
  target,
  job,
  backup,
}: {
  project: string;
  target: Pick<TargetReport, "kind" | "name">;
  job: Pick<JobReport, "name" | "state" | "backup" | "removed">;
  backup: BackupView;
}) {
  const act = useRun();
  const [typed, setTyped] = useState("");
  const field = useId();
  const blocked = restoreBlocked(job, backup);
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <AlertDialog onOpenChange={(open) => (open ? setTyped("") : undefined)}>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={blocked !== undefined || act.busy}
            title={
              blocked ?? `Restore this backup of ${job.name} in ${target.name}`
            }
          >
            <RotateCcw className="size-3" /> Restore
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore {job.name} in {target.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Runs {job.name}&apos;s restore command now with the backup from{" "}
              {when(backup.finishedAt)}
              {backup.bytes === undefined
                ? ""
                : ` (${formatBytes(backup.bytes)})`}
              . It replaces what it restores. Rig does not stop {target.name}
              &apos;s Services, so the command must handle that itself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={field}>
              Type <span className="font-mono">{job.name}</span> to confirm
            </Label>
            <Input
              id={field}
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!restoreConfirmed(typed, job.name)}
              onClick={() =>
                void act.run(
                  restoreCommand(project, target, job.name, backup.id),
                  // What was typed goes along: the server checks it again, so no script can skip this dialog.
                  (command) => runRestore({ command, typed }),
                )
              }
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {act.result && !act.failure ? (
        <span className="text-xs text-muted-foreground">restoring</span>
      ) : null}
      <Failure failure={act.failure} />
    </div>
  );
}
