import { targetJobs } from "@/lib/jobs";
import { target } from "@/server/target";
import { Panel } from "@/components/bits";
import { JobsTable, JobsUnavailable } from "@/components/jobs-table";

/** This Target's scheduled jobs and backups. */
export default async function TargetJobsPage({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { project, target: report } = await target(params);
  const jobs = targetJobs(report);
  return (
    <Panel
      flush
      {...(jobs.supported
        ? {
            title: "Jobs",
            description: "Scheduled jobs and backups this Target runs.",
          }
        : {})}
    >
      {jobs.supported && jobs.jobs.length ? (
        <JobsTable
          project={project.name}
          target={report.name}
          jobs={jobs.jobs}
          now={Date.now()}
        />
      ) : (
        <JobsUnavailable />
      )}
    </Panel>
  );
}
