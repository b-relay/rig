import { Plus } from "lucide-react";
import type { ListResult } from "../types";
import { href, useApi, useRead, type Read } from "../hooks";
import { Empty, Failure, Mono, Panel, State } from "../ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function Overview({ projects }: { projects: Read<ListResult> }) {
  return (
    <>
      <h1 className="text-3xl font-bold [font-stretch:115%]">Projects</h1>
      <Panel
        title="Registered on this Host"
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={href("new")}>
              <Plus /> Add Project
            </a>
          </Button>
        }
      >
        <Failure error={projects.error} />
        {projects.data?.projects.length === 0 ? (
          <Empty>
            No Projects are registered on this Host. Add one, or run{" "}
            <code>rig init</code> in a repository.
          </Empty>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data?.projects.map((project) => (
            <ProjectCard key={project.name} project={project} />
          ))}
        </div>
      </Panel>
    </>
  );
}
function ProjectCard({ project }: { project: ListResult["projects"][number] }) {
  const api = useApi();
  const status = useRead(
    (signal) =>
      api.command({ action: "status", project: project.name }, signal),
    `status:${project.name}`,
    5000,
  );
  return (
    <a
      href={href("projects", project.name)}
      className="block min-w-0 text-foreground no-underline hover:no-underline"
    >
      <Card className="h-full gap-3 border-l-4 border-l-transparent py-4 transition-colors hover:border-l-primary">
        <CardContent className="flex flex-col gap-2 px-4">
          <div className="text-lg font-semibold">{project.name}</div>
          <Mono
            className="block truncate break-normal text-muted-foreground"
            title={project.repoPath}
          >
            {project.repoPath}
          </Mono>
          {project.missing ? <State value="missing" /> : null}
          <ul className="flex flex-col gap-1 text-sm">
            {status.data?.targets.map((target) => (
              <li
                key={`${target.kind}:${target.name}`}
                className="flex items-center justify-between gap-2"
              >
                <span>{target.name}</span>
                <State value={target.state} />
              </li>
            ))}
          </ul>
          {status.error ? <State value="unknown" /> : null}
        </CardContent>
      </Card>
    </a>
  );
}
