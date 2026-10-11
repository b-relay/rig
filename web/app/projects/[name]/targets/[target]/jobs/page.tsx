import { targetJobs } from "@/lib/jobs";
import { target } from "@/server/target";
import { projectBackups } from "@/server/status";
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
  // Backups are shown when rigd lists them; the jobs stand on their own when it cannot.
  const backups = await projectBackups(project.name);
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Scheduled jobs and backups of {report.name}. Run now (Back up now for a
        backup job) runs one here whatever its schedule; Restore puts a backup
        back once you type the job's name.
      </p>
      <JobCards
        project={project.name}
        target={report}
        jobs={jobs}
        backups={backups.ok ? backups.value.backups : []}
        now={Date.now()}
      />
    </section>
  );
}
