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
      {...(jobs.length
        ? {
            title: "Jobs",
            description:
              "Scheduled jobs and backups of this Target. Run now runs one here whatever its schedule.",
          }
        : {})}
    >
      {jobs.length ? (
        <JobsTable
          project={project.name}
          target={report}
          jobs={jobs}
          now={Date.now()}
        />
      ) : (
        <JobsUnavailable />
      )}
    </Panel>
  );
}
