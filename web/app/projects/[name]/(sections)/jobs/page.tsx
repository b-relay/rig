import { targetJobs } from "@/lib/jobs";
import { orderedTargets } from "@/lib/overview";
import { project } from "@/server/project";
import { projectStatus } from "@/server/status";
import { Failure, Panel } from "@/components/bits";
import { JobsTable, JobsUnavailable } from "@/components/jobs-table";

/** Every Target's scheduled jobs and backups, one panel per Target that has any. */
export default async function JobsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  const status = await projectStatus(found.name);
  if (!status.ok) return <Failure failure={status.failure} />;
  const withJobs = orderedTargets(status.value.targets).flatMap((target) => {
    const jobs = targetJobs(target);
    return jobs.length ? [{ target, jobs }] : [];
  });
  if (withJobs.length === 0)
    return (
      <Panel flush>
        <JobsUnavailable />
      </Panel>
    );
  const now = Date.now();
  return (
    <div className="grid gap-4">
      {withJobs.map(({ target, jobs }) => (
        <Panel key={target.name} title={target.name} flush>
          <JobsTable
            project={found.name}
            target={target}
            jobs={jobs}
            now={now}
          />
        </Panel>
      ))}
    </div>
  );
}
