"use client";

import { Archive, Play } from "lucide-react";
import { runBlocked, runJobCommand, type JobView } from "@/lib/jobs";
import type { TargetReport } from "@/lib/types";
import { Failure } from "./bits";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";

/** Starts one run of a job now, as `rig run <job> <target>` does; for a backup job, Back up now makes a backup. rigd refuses it while a run of the job goes; the
 * refusal, like any failure, shows beneath the button, and the page refreshes to show the run. */
export function RunJobButton({
  project,
  target,
  job,
}: {
  project: string;
  target: Pick<TargetReport, "kind" | "name" | "refusals">;
  job: JobView;
}) {
  const act = useRun();
  const blocked = runBlocked(job, target);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={blocked !== undefined || act.busy}
        title={
          blocked ??
          (job.backup
            ? `Back up ${job.name} now in ${target.name}: a fresh backup, kept if the run succeeds`
            : `Run ${job.name} now in ${target.name}`)
        }
        onClick={() => void act.run(runJobCommand(project, target, job.name))}
      >
        {job.backup ? (
          <>
            <Archive className="size-3.5" /> Back up now
          </>
        ) : (
          <>
            <Play className="size-3.5" /> Run now
          </>
        )}
      </Button>
      {act.result && !act.failure ? (
        <span className="text-xs text-muted-foreground">started</span>
      ) : null}
      <Failure failure={act.failure} />
    </div>
  );
}
