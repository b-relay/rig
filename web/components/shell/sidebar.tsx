import Link from "next/link";
import { Suspense } from "react";
import { Plus } from "lucide-react";
import { orderedTargets, worstTone } from "@/lib/overview";
import { projectHref, targetHref } from "@/lib/target";
import { projectList, projectStatus } from "@/server/status";
import { Dot } from "../bits";
import { NavLink } from "./nav-link";
import { SECTIONS } from "./sections";
import { cn } from "@/lib/utils";

const ITEM =
  "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground no-underline hover:bg-muted hover:text-foreground";
const ACTIVE = "bg-muted font-medium text-foreground";

/** The site's frame on wide screens and in the phone menu: the sections, then every Project with
 * its Targets and the state of each, streamed in as rigd answers. */
export function Sidebar({ sandbox }: { sandbox: boolean }) {
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4">
      <div className="flex h-8 items-center gap-2 px-2">
        <Link href="/" className="wordmark text-lg text-ink no-underline">
          RIG
        </Link>
        {sandbox ? (
          <span
            className="hazard-tag"
            title="This copy drives a throwaway rigd of its own, seeded with demo Projects."
          >
            sandbox
          </span>
        ) : null}
      </div>
      <nav aria-label="Sections">
        <ul className="flex flex-col gap-0.5">
          {SECTIONS.map(({ href, label, icon: Icon, ...rest }) => (
            <li key={href}>
              <NavLink
                href={href}
                exact={"exact" in rest}
                className={ITEM}
                activeClassName={ACTIVE}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <nav aria-label="Projects" className="flex flex-col gap-1">
        <div className="flex items-center justify-between px-2">
          <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Projects
          </span>
          <Link
            href="/projects/new"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Add Project"
            aria-label="Add Project"
          >
            <Plus className="size-3.5" aria-hidden />
          </Link>
        </div>
        <Suspense fallback={<ProjectNames />}>
          <ProjectTree />
        </Suspense>
      </nav>
    </div>
  );
}
/** The Project names alone, while their statuses are on the way. */
async function ProjectNames() {
  const list = await projectList();
  if (!list.ok) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {list.value.projects.map((project) => (
        <li key={project.name}>
          <NavLink
            href={projectHref(project.name)}
            exact
            className={ITEM}
            activeClassName={ACTIVE}
          >
            <Dot value="unknown" className="bg-rule" />
            <span className="truncate">{project.name}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}
async function ProjectTree() {
  const list = await projectList();
  if (!list.ok)
    return (
      <p className="px-2 text-xs text-bad" title={list.failure.message}>
        rigd did not list the Projects.
      </p>
    );
  if (list.value.projects.length === 0)
    return (
      <p className="px-2 text-xs text-muted-foreground">
        None yet. <Link href="/projects/new">Add one</Link>.
      </p>
    );
  const entries = await Promise.all(
    list.value.projects.map(async (project) => ({
      project,
      status: project.missing ? undefined : await projectStatus(project.name),
    })),
  );
  return (
    <ul className="flex flex-col gap-0.5">
      {entries.map(({ project, status }) => {
        const targets =
          status?.ok === true ? orderedTargets(status.value.targets) : [];
        const tone = project.missing
          ? "missing"
          : status && !status.ok
            ? "failed"
            : worstToneWord(targets.map((target) => target.state));
        return (
          <li key={project.name}>
            <NavLink
              href={projectHref(project.name)}
              exact
              className={ITEM}
              activeClassName={ACTIVE}
            >
              <Dot value={tone} />
              <span className="truncate">{project.name}</span>
            </NavLink>
            {targets.length ? (
              <ul className="mt-0.5 mb-1 ml-[0.6875rem] flex flex-col border-l border-rule pl-2">
                {targets.map((target) => (
                  <li key={target.name}>
                    <NavLink
                      href={targetHref(project.name, target.name)}
                      className={cn(ITEM, "h-7 text-[13px]")}
                      activeClassName={ACTIVE}
                      title={`${target.name}: ${target.state}`}
                    >
                      <Dot value={target.state} className="size-1.5" />
                      <span className="truncate">{target.name}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
/** A word whose tone is the worst of `states`, for a Project's dot. */
function worstToneWord(states: readonly string[]): string {
  const tone = worstTone(states);
  return tone === "bad"
    ? "failed"
    : tone === "warn"
      ? "degraded"
      : tone === "busy"
        ? "starting"
        : tone === "good"
          ? "running"
          : "stopped";
}
