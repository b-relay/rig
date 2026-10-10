import Link from "next/link";
import { Suspense } from "react";
import { LayoutGrid, Plus, Rows3 } from "lucide-react";
import type { ProjectEntry } from "@/lib/board-rows";
import { overviewSummary } from "@/lib/overview";
import type { ListResult } from "@/lib/types";
import { projectList, projectStatus } from "@/server/status";
import { Board } from "@/components/board";
import { Empty, Failure, PageHeader, Skeleton, Stat } from "@/components/bits";
import { ProjectCard } from "@/components/project-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type View = "cards" | "table";
/** The root page: every Project and Target this Mac runs, as cards with quick actions, or as the
 * one dense table (`?view=table`). */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const view: View = (await searchParams).view === "table" ? "table" : "cards";
  const list = await projectList();
  const projects = list.ok ? list.value.projects : [];
  return (
    <>
      <PageHeader
        title="Overview"
        description={
          list.ok
            ? `Every Project on this Mac, with its working copy, stable Target and Previews.`
            : "rigd did not answer."
        }
        actions={
          <>
            <ViewSwitch view={view} />
            <Button asChild size="sm">
              <Link href="/projects/new" className="no-underline">
                <Plus /> Add Project
              </Link>
            </Button>
          </>
        }
      />
      {!list.ok ? <Failure failure={list.failure} /> : null}
      {list.ok && projects.length === 0 ? (
        <Empty>
          No Project is registered yet.{" "}
          <Link href="/projects/new">Add one</Link>, or run{" "}
          <code>rig init</code> in a repository.
        </Empty>
      ) : null}
      {projects.length > 0 && view === "table" ? (
        <Board projects={projects} />
      ) : null}
      {projects.length > 0 && view === "cards" ? (
        <Suspense fallback={<CardsLoading count={projects.length} />}>
          <Cards projects={projects} />
        </Suspense>
      ) : null}
    </>
  );
}
async function Cards({ projects }: { projects: ListResult["projects"] }) {
  const entries: ProjectEntry[] = await Promise.all(
    projects.map(async (project) => ({
      project,
      ...(project.missing ? {} : { status: await projectStatus(project.name) }),
    })),
  );
  const summary = overviewSummary(entries);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Projects" value={summary.projects} />
        <Stat label="Targets" value={summary.targets} />
        <Stat
          label="Running"
          value={summary.live}
          tone={summary.live ? "good" : undefined}
        />
        <Stat
          label="Need attention"
          value={summary.attention}
          tone={summary.attention ? "warn" : undefined}
        />
      </div>
      <div className="grid gap-4">
        {entries.map((entry) => (
          <ProjectCard key={entry.project.name} {...entry} />
        ))}
      </div>
    </>
  );
}
function CardsLoading({ count }: { count: number }) {
  return (
    <div className="grid gap-4">
      {Array.from({ length: Math.min(count, 4) }, (_, index) => (
        <div
          key={index}
          className="rounded-lg border border-rule bg-sheet p-4 shadow-xs"
        >
          <Skeleton lines={3} />
        </div>
      ))}
    </div>
  );
}
function ViewSwitch({ view }: { view: View }) {
  const item = (value: View, label: string, Icon: typeof Rows3) => (
    <Link
      href={value === "cards" ? "/" : "/?view=table"}
      aria-current={view === value ? "page" : undefined}
      title={`${label} view`}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs text-muted-foreground no-underline hover:text-foreground",
        view === value && "bg-sheet text-foreground shadow-xs",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </Link>
  );
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-rule bg-muted p-0.5">
      {item("cards", "Cards", LayoutGrid)}
      {item("table", "Table", Rows3)}
    </div>
  );
}
