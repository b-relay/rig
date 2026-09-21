import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  LayoutGrid,
  Menu,
  Plus,
  Server,
  Stethoscope,
} from "lucide-react";
import { createRigdApi } from "./api";
import { ApiContext, href, useApi, useRead, useRoute } from "./hooks";
import { Failure } from "./ui";
import { Overview } from "./views/Overview";
import { Project } from "./views/Project";
import { NewProject } from "./views/NewProject";
import { ActivityView } from "./views/Activity";
import { DoctorView } from "./views/Doctor";
import { Daemon } from "./views/Daemon";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export function App() {
  const api = useMemo(
    () => createRigdApi((path, init) => fetch(path, init)),
    [],
  );
  return (
    <ApiContext.Provider value={api}>
      <Shell />
    </ApiContext.Provider>
  );
}
function Shell() {
  const api = useApi();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const health = useRead(() => api.health(), "health", 5000);
  const queue = useRead(
    (signal) => api.command({ action: "queue" }, signal),
    "queue",
    2000,
  );
  const projects = useRead(
    (signal) => api.command({ action: "list" }, signal),
    "list",
    5000,
  );
  const [section, name, tab] = route;
  // Following a link closes the drawer; the route array is new on every hash change.
  useEffect(() => setOpen(false), [route]);
  const daemon = health.data
    ? `rigd ${health.data.version ?? ""}, pid ${health.data.pid}`
    : health.error
      ? "rigd unreachable"
      : "connecting…";
  const work = queue.data?.running
    ? `${queue.data.running.action} ${queue.data.running.project ?? ""}, ${queue.data.waiting} waiting`
    : "idle";
  const nav = (
    <>
      <a
        href={href()}
        className="mb-3 px-3 text-2xl font-bold [font-stretch:125%] text-sidebar-foreground"
      >
        Rig
      </a>
      <NavGroup>Projects</NavGroup>
      <NavLink href={href()} active={section === undefined}>
        <LayoutGrid className="size-4" /> All Projects
      </NavLink>
      {projects.data?.projects.map((project) => (
        <NavLink
          key={project.name}
          href={href("projects", project.name)}
          active={section === "projects" && name === project.name}
        >
          <span className="truncate">{project.name}</span>
          {project.missing ? (
            <span className="text-xs text-bad">missing</span>
          ) : null}
        </NavLink>
      ))}
      <NavLink href={href("new")} active={section === "new"}>
        <Plus className="size-4" /> Add Project
      </NavLink>
      <NavGroup>Host</NavGroup>
      <NavLink href={href("activity")} active={section === "activity"}>
        <Activity className="size-4" /> Activity
      </NavLink>
      <NavLink href={href("doctor")} active={section === "doctor"}>
        <Stethoscope className="size-4" /> Doctor
      </NavLink>
      <NavLink href={href("daemon")} active={section === "daemon"}>
        <Server className="size-4" /> rigd
      </NavLink>
      <div className="mt-auto px-3 pt-4 text-xs text-sidebar-foreground/70">
        <div>{daemon}</div>
        <div>{work}</div>
      </div>
    </>
  );
  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col gap-0.5 overflow-y-auto bg-sidebar p-3 text-sidebar-foreground md:flex">
        {nav}
      </aside>
      <header className="sticky top-0 z-40 flex h-14 items-center gap-2 bg-sidebar px-3 text-sidebar-foreground md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => setOpen(true)}
          >
            <Menu />
          </Button>
          <SheetContent
            side="left"
            className="flex w-72 flex-col gap-0.5 border-sidebar-border bg-sidebar p-3 pt-10 text-sidebar-foreground"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            {nav}
          </SheetContent>
        </Sheet>
        <a
          href={href()}
          className="text-xl font-bold [font-stretch:125%] text-sidebar-foreground"
        >
          Rig
        </a>
        <span className="ml-auto truncate text-xs text-sidebar-foreground/70">
          {work === "idle" ? daemon : work}
        </span>
      </header>
      <main className="flex min-w-0 max-w-6xl flex-col gap-4 p-4 md:p-8">
        {health.error ? <Failure error={health.error} /> : null}
        {section === "projects" && name ? (
          <Project
            key={name}
            name={name}
            tab={tab ?? "targets"}
            registration={projects.data?.projects.find((p) => p.name === name)}
            reloadProjects={projects.reload}
          />
        ) : section === "new" ? (
          <NewProject reloadProjects={projects.reload} />
        ) : section === "activity" ? (
          <ActivityView operation={name} />
        ) : section === "doctor" ? (
          <DoctorView />
        ) : section === "daemon" ? (
          <Daemon health={health.data} queue={queue.data} />
        ) : (
          <Overview projects={projects} />
        )}
      </main>
    </div>
  );
}
function NavGroup({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 px-3 pb-1 text-xs text-sidebar-foreground/60">
      {children}
    </div>
  );
}
function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      data-active={active}
      className={cn(
        "flex min-h-9 items-center gap-2 rounded-r-md border-l-4 border-transparent px-2 text-sm text-sidebar-foreground no-underline hover:bg-sidebar-accent hover:no-underline",
        active && "border-sidebar-primary bg-sidebar-accent font-medium",
      )}
    >
      {children}
    </a>
  );
}
