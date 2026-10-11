import Link from "next/link";
import { Suspense } from "react";
import { Plus } from "lucide-react";
import { projectHealth } from "@/lib/health";
import { orderedTargets } from "@/lib/overview";
import { projectHref, targetHref } from "@/lib/target";
import { projectList, projectStatus } from "@/server/status";
import { Dot, EYEBROW, HealthDot } from "../bits";
import { ProjectIcon } from "../project-icon";
import { Brand } from "./brand";
import { NavLink } from "./nav-link";
import { SECTIONS } from "./sections";
import { cn } from "@/lib/utils";

const ITEM =
  "flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm text-muted-foreground no-underline transition-colors hover:bg-sidebar-accent hover:text-foreground";
const ACTIVE =
  "bg-card font-medium text-foreground shadow-xs ring-1 ring-border hover:bg-card";

/** The site's frame on wide screens and in the phone menu: the sections, then every Project with
 * its icon and health and its Targets with their states, streamed in as rigd answers. */
export function Sidebar({ sandbox }: { sandbox: boolean }) {
  return (
    <div className="no-scrollbar flex h-full flex-col gap-6 overflow-y-auto px-3 py-4">
      <Brand sandbox={sandbox} className="h-8 px-1.5" />
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
      <nav aria-label="Projects" className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between px-2">
          <span className={EYEBROW}>Projects</span>
          <Link
            href="/projects/new"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
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
            <ProjectIcon project={project.name} size="sm" />
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
        const health =
          project.missing || (status && !status.ok)
            ? "red"
            : projectHealth(targets.map((target) => target.state));
        const stable = targets.find((target) => target.kind === "stable");
        return (
          <li key={project.name}>
            <NavLink
              href={projectHref(project.name)}
              exact
              className={ITEM}
              activeClassName={ACTIVE}
            >
              <ProjectIcon
                project={project.name}
                favicon={stable?.route !== undefined}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <HealthDot health={health} className="size-1.5" />
            </NavLink>
            {targets.length ? (
              <ul className="mt-0.5 mb-1.5 ml-[1.1875rem] flex flex-col gap-px border-l pl-2">
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
