import { CalendarClock } from "lucide-react";
import { formatDuration } from "@/lib/deployments";
import type { JobView } from "@/lib/jobs";
import { jobTile, until } from "@/lib/matrix";
import { ago, when } from "@/lib/present";
import type { TargetReport } from "@/lib/types";
import { CARD, Empty, HEALTH_DOT, HEALTH_TILE, Mono } from "./bits";
import { RunJobButton } from "./run-job-button";
import { cn } from "@/lib/utils";

/** One Target's scheduled jobs and backups, each as a card: its schedule, how its last run went as a
 * tinted tile, when it runs next, and Run now. */
export function JobCards({
  project,
  target,
  jobs,
  now,
}: {
  project: string;
  target: Pick<TargetReport, "kind" | "name">;
  jobs: readonly JobView[];
  now: number;
}) {
  return (
    <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {jobs.map((job) => {
        const tile = jobTile(job, now);
        const health = tile.absent ? "gray" : tile.health;
        return (
          <li key={job.name} className={cn(CARD, "flex flex-col gap-3 p-3")}>
            <div className="flex items-start justify-between gap-3 px-1">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-medium">
                  <CalendarClock
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate">{job.name}</span>
                </p>
                {job.removed ? (
                  <p className="text-xs text-muted-foreground">
                    removed from rig.yaml
                  </p>
                ) : (
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <Mono className="break-normal text-foreground">
                      {job.schedule}
                    </Mono>
                    {job.timeZone}
                  </p>
                )}
              </div>
              <RunJobButton project={project} target={target} job={job} />
            </div>
            <div
              className={cn(
                "flex flex-col gap-0.5 rounded-lg px-3 py-2 text-xs",
                HEALTH_TILE[health],
              )}
            >
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="flex items-center gap-1.5 font-medium">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      HEALTH_DOT[health],
                      job.state === "running" && "busy-dot",
                    )}
                  />
                  {tile.absent ? "unknown" : tile.word}
                </span>
                {job.state !== "running" && job.last ? (
                  <span className="opacity-80" title={when(job.last.startedAt)}>
                    {ago(job.last.startedAt, now)}
                    {job.last.durationMs !== undefined
                      ? `, ${formatDuration(job.last.durationMs)}`
                      : ""}
                  </span>
                ) : null}
              </span>
              {job.state !== "running" && job.last?.summary ? (
                <span className="opacity-80">{job.last.summary}</span>
              ) : null}
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              {job.nextRunAt ? (
                <>
                  Next run{" "}
                  <span className="text-foreground" title={when(job.nextRunAt)}>
                    {when(job.nextRunAt)}
                  </span>{" "}
                  ({until(job.nextRunAt, now)})
                </>
              ) : (
                (job.reason ?? "Not scheduled.")
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
/** What the Jobs tab says when no Target has a job. */
export function JobsUnavailable() {
  return (
    <Empty icon={CalendarClock} title="No scheduled jobs">
      Jobs and backups are declared under <code>jobs:</code> in rig.yaml, each
      with a cron schedule, and run with <code>rig run</code> or Run now here. A
      Target shows its jobs once its plan has them: after{" "}
      <code>rig restart working</code> for the working Target, or the next
      deploy for the stable Target and Previews.
    </Empty>
  );
}
