import Link from "next/link";
import { CalendarClock, Play } from "lucide-react";
import { formatDuration } from "@/lib/deployments";
import { RUN_JOB_SUPPORTED, type JobView } from "@/lib/jobs";
import { ago, when } from "@/lib/present";
import { targetHref } from "@/lib/target";
import { Mono, StatePill } from "./bits";
import { Button } from "@/components/ui/button";
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
/** One Target's scheduled jobs and backups: schedule, state, last run and next run. */
export function JobsTable({
  project,
  target,
  jobs,
  now,
  showTarget = false,
}: {
  project: string;
  target: string;
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
                  <Link href={targetHref(project, target)}>{target}</Link>
                </TableCell>
              ) : null}
              <TableCell className="px-4 py-2">
                <Mono className="break-normal">{job.schedule}</Mono>
                <span className="block text-xs text-muted-foreground">
                  {job.timeZone}
                </span>
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
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={!RUN_JOB_SUPPORTED || job.state === "running"}
                  title={
                    RUN_JOB_SUPPORTED
                      ? `Run ${job.name} now`
                      : "rigd cannot start a job from here yet"
                  }
                >
                  <Play className="size-3.5" /> Run now
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
/** What the Jobs tab says while rigd reports no scheduled jobs. */
export function JobsUnavailable() {
  return (
    <div className="flex flex-col items-start gap-3 px-6 py-10">
      <CalendarClock className="size-8 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">No scheduled jobs yet</h2>
        <p className="max-w-xl text-sm text-muted-foreground">
          Jobs and backups are declared under <code>jobs:</code> in rig.yaml,
          each with a cron schedule, and run with <code>rig run</code>. This
          rigd does not report any yet; once it does, each job shows here with
          its schedule, last run, outcome and next run.
        </p>
      </div>
    </div>
  );
}
