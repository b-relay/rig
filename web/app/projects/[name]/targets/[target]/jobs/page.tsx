import { targetJobs } from "@/lib/jobs";
import { target } from "@/server/target";
import { JobCards, JobsUnavailable } from "@/components/job-cards";

/** This Target's scheduled jobs and backups. Run now runs one here whatever its schedule. */
export default async function TargetJobsPage({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { project, target: report } = await target(params);
  const jobs = targetJobs(report);
  if (!jobs.length) return <JobsUnavailable />;
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Scheduled jobs and backups of {report.name}. Run now runs one here
        whatever its schedule.
      </p>
      <JobCards
        project={project.name}
        target={report}
        jobs={jobs}
        now={Date.now()}
      />
    </section>
  );
}
