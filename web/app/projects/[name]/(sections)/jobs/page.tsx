import Link from "next/link";
import { targetJobs } from "@/lib/jobs";
import { orderedTargets } from "@/lib/overview";
import { targetHref } from "@/lib/target";
import { project } from "@/server/project";
import { projectBackups, projectStatus } from "@/server/status";
import { Dot, Failure } from "@/components/bits";
import { JobCards, JobsUnavailable } from "@/components/job-cards";

/** Every Target's scheduled jobs and backups, grouped under each Target that has any. */
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
  if (withJobs.length === 0) return <JobsUnavailable />;
  // Backups are shown when rigd lists them; the jobs stand on their own when it cannot.
  const backups = await projectBackups(found.name);
  const now = Date.now();
  return (
    <div className="flex flex-col gap-6">
      {withJobs.map(({ target, jobs }) => (
        <section key={target.name} className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Dot value={target.state} />
            <Link
              href={targetHref(found.name, target.name)}
              className="text-foreground no-underline hover:underline"
            >
              {target.name}
            </Link>
          </h2>
          <JobCards
            project={found.name}
            target={target}
            jobs={jobs}
            backups={backups.ok ? backups.value.backups : []}
            now={now}
          />
        </section>
      ))}
    </div>
  );
}
