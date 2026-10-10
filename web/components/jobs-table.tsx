import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { formatDuration } from "@/lib/deployments";
import type { JobView } from "@/lib/jobs";
import { ago, when } from "@/lib/present";
import { targetHref } from "@/lib/target";
import type { TargetReport } from "@/lib/types";
import { Mono, StatePill } from "./bits";
import { RunJobButton } from "./run-job-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const HEAD =
  "h-8 px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";
/** One Target's scheduled jobs and backups: schedule, state, last run and next run, and Run now. */
export function JobsTable({
  project,
  target,
  jobs,
  now,
  showTarget = false,
}: {
  project: string;
  target: Pick<TargetReport, "kind" | "name">;
  jobs: readonly JobView[];
  now: number;
  showTarget?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[48rem] text-[13px]">
        <TableHeader>
          <TableRow className="border-rule hover:bg-transparent">
            <TableHead className={HEAD}>Job</TableHead>
            {showTarget ? <TableHead className={HEAD}>Target</TableHead> : null}
            <TableHead className={HEAD}>Schedule</TableHead>
            <TableHead className={HEAD}>Last run</TableHead>
            <TableHead className={HEAD}>Next run</TableHead>
            <TableHead className={`${HEAD} text-right`}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.name} className="border-rule/60">
              <TableCell className="px-4 py-2">
                <span className="flex items-center gap-2 font-medium">
                  {job.name}
                  {job.state === "running" ? (
                    <StatePill value="running" />
                  ) : null}
                </span>
              </TableCell>
              {showTarget ? (
                <TableCell className="px-4 py-2">
                  <Link href={targetHref(project, target.name)}>
                    {target.name}
                  </Link>
                </TableCell>
              ) : null}
              <TableCell className="px-4 py-2">
                {job.removed ? (
                  <span className="text-xs text-muted-foreground">
                    removed from rig.yaml
                  </span>
                ) : (
                  <>
                    <Mono className="break-normal">{job.schedule}</Mono>
                    <span className="block text-xs text-muted-foreground">
                      {job.timeZone}
                    </span>
                  </>
                )}
              </TableCell>
              <TableCell className="max-w-80 px-4 py-2 whitespace-normal">
                {job.last ? (
                  <>
                    <span className="flex items-center gap-2">
                      <StatePill value={job.last.outcome ?? "unknown"} />
                      <span title={when(job.last.startedAt)}>
                        {ago(job.last.startedAt, now)}
                      </span>
                      {job.last.durationMs !== undefined ? (
                        <span className="text-muted-foreground">
                          {formatDuration(job.last.durationMs)}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {job.last.summary}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">never run</span>
                )}
              </TableCell>
              <TableCell className="px-4 py-2">
                {job.nextRunAt ? (
                  <span title={when(job.nextRunAt)}>{when(job.nextRunAt)}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {job.reason ?? "not scheduled"}
                  </span>
                )}
              </TableCell>
              <TableCell className="px-4 py-2 text-right">
                <RunJobButton project={project} target={target} job={job} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
/** What the Jobs tab says when no Target has a job. */
export function JobsUnavailable() {
  return (
    <div className="flex flex-col items-start gap-3 px-6 py-10">
      <CalendarClock className="size-8 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">No scheduled jobs</h2>
        <p className="max-w-xl text-sm text-muted-foreground">
          Jobs and backups are declared under <code>jobs:</code> in rig.yaml,
          each with a cron schedule, and run with <code>rig run</code> or Run
          now here. A Target shows its jobs once its plan has them: after{" "}
          <code>rig restart working</code> for the working Target, or the next
          deploy for the stable Target and Previews.
        </p>
      </div>
    </div>
  );
}
