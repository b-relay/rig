"use client";

import { Play } from "lucide-react";
import { canRunNow, runJobCommand, type JobView } from "@/lib/jobs";
import type { TargetReport } from "@/lib/types";
import { Failure } from "./bits";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";

/** Starts one run of a job now, as `rig run <job> <target>` does. rigd refuses it while a run of the job goes; the
 * refusal, like any failure, shows beneath the button, and the page refreshes to show the run. */
export function RunJobButton({
  project,
  target,
  job,
}: {
  project: string;
  target: Pick<TargetReport, "kind" | "name">;
  job: JobView;
}) {
  const act = useRun();
  const allowed = canRunNow(job);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={!allowed || act.busy}
        title={
          job.removed
            ? "This job is no longer in rig.yaml; its last run finishes on its own"
            : job.state === "running"
              ? `${job.name} is running; runs never overlap`
              : `Run ${job.name} now in ${target.name}`
        }
        onClick={() => void act.run(runJobCommand(project, target, job.name))}
      >
        <Play className="size-3.5" /> Run now
      </Button>
      {act.result && !act.failure ? (
        <span className="text-xs text-muted-foreground">started</span>
      ) : null}
      <Failure failure={act.failure} />
    </div>
  );
}
