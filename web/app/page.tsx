import Link from "next/link";
import { Suspense } from "react";
import { FolderPlus, Plus } from "lucide-react";
import { projectMatrix } from "@/lib/matrix";
import { overviewSummary, type ProjectEntry } from "@/lib/overview";
import type { ListResult } from "@/lib/types";
import { projectList, projectStatus } from "@/server/status";
import { Empty, Failure, PageHeader } from "@/components/bits";
import { MatrixLoading, ProjectMatrix } from "@/components/project-matrix";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Project = ListResult["projects"][number];
/** The root page: one matrix per Project on this Mac, its Targets across the top and its Services
 * down the side. Each matrix streams in as its Project's status arrives. */
export default async function OverviewPage() {
  const list = await projectList();
  const projects = list.ok ? list.value.projects : [];
  return (
    <>
      <PageHeader
        title="Overview"
        description={
          list.ok ? (
            <Suspense fallback="Every Project on this Mac.">
              <Summary projects={projects} />
            </Suspense>
          ) : (
            "rigd did not answer."
          )
        }
        actions={
          <Button asChild size="sm">
            <Link
              href="/projects/new"
              className="no-underline"
              aria-label="Add Project"
            >
              <Plus /> <span className="hidden sm:inline">Add Project</span>
            </Link>
          </Button>
        }
      />
      {!list.ok ? <Failure failure={list.failure} /> : null}
      {list.ok && projects.length === 0 ? (
        <Empty icon={FolderPlus} title="No Project yet">
          <Link href="/projects/new">Add one</Link>, or run{" "}
          <code>rig init</code> in a repository.
        </Empty>
      ) : null}
      <div className="flex flex-col gap-8 sm:gap-10">
        {projects.map((project) => (
          <Suspense
            key={project.name}
            fallback={<MatrixLoading project={project.name} />}
          >
            <Matrix project={project} />
          </Suspense>
        ))}
      </div>
    </>
  );
}
async function entry(project: Project): Promise<ProjectEntry> {
  return project.missing
    ? { project }
    : { project, status: await projectStatus(project.name) };
}
async function Matrix({ project }: { project: Project }) {
  return (
    <ProjectMatrix
      matrix={projectMatrix(await entry(project))}
      now={Date.now()}
    />
  );
}
/** The Host in one line: how many Projects and Targets, how many run, and how many need a look. */
async function Summary({ projects }: { projects: readonly Project[] }) {
  const summary = overviewSummary(await Promise.all(projects.map(entry)));
  const part = (count: number, word: string, dot?: string) => (
    <span className="inline-flex items-center gap-1.5">
      {dot ? (
        <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
      ) : null}
      <span className="font-medium text-foreground tabular-nums">{count}</span>
      {word}
    </span>
  );
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {part(summary.projects, summary.projects === 1 ? "Project" : "Projects")}
      {part(summary.targets, summary.targets === 1 ? "Target" : "Targets")}
      {part(summary.live, "running", summary.live ? "bg-good" : undefined)}
      {summary.attention
        ? part(summary.attention, "need attention", "bg-warn")
        : null}
    </span>
  );
}
