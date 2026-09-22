import Link from "next/link";
import { Suspense } from "react";
import { AlertTriangle } from "lucide-react";
import { attempt } from "@/lib/outcome";
import { KIND_LABEL, shortCommit, targetWarnings } from "@/lib/present";
import { routeUrl, targetKey } from "@/lib/target";
import type {
  ComponentReport,
  ListResult,
  ProjectStatusReport,
} from "@/lib/types";
import { read } from "@/server/daemon";
import { Failure, Mono, State } from "./bits";
import { StartWorkingCopy } from "./start-working-copy";
import { TargetActions } from "./target-actions";
import { cn } from "@/lib/utils";

type Project = ListResult["projects"][number];
const COLUMNS = 8;
const HEAD =
  "px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap";
const CELL = "px-3 py-2.5 align-top";
/** Every Target on this Host in one table, grouped by Project. Each Project's rows stream in as
 * its status arrives, so a slow Project never holds the others back. */
export function Board({
  projects,
  showProjectRows = true,
}: {
  projects: readonly Project[];
  showProjectRows?: boolean;
}) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0 sm:rounded-md sm:border sm:border-rule sm:bg-sheet">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="border-b border-rule">
          <tr>
            <th className={HEAD}>Target</th>
            <th className={HEAD}>Kind</th>
            <th className={HEAD}>State</th>
            <th className={HEAD}>Branch</th>
            <th className={HEAD}>Commit</th>
            <th className={HEAD}>Route</th>
            <th className={HEAD}>Components</th>
            <th className={cn(HEAD, "text-right")}>Actions</th>
          </tr>
        </thead>
        {projects.map((project) => (
          <Suspense
            key={project.name}
            fallback={
              <ProjectRows
                project={project}
                showProjectRows={showProjectRows}
              />
            }
          >
            <ProjectStatusRows
              project={project}
              showProjectRows={showProjectRows}
            />
          </Suspense>
        ))}
      </table>
    </div>
  );
}
async function ProjectStatusRows({
  project,
  showProjectRows,
}: {
  project: Project;
  showProjectRows: boolean;
}) {
  const status = project.missing
    ? undefined
    : await attempt(read({ action: "status", project: project.name }));
  return (
    <ProjectRows
      project={project}
      status={status}
      showProjectRows={showProjectRows}
    />
  );
}
function ProjectRows({
  project,
  status,
  showProjectRows,
}: {
  project: Project;
  /** Absent while the status is still on its way. */
  status?: Awaited<ReturnType<typeof attempt<ProjectStatusReport>>>;
  showProjectRows: boolean;
}) {
  const report = status?.ok ? status.value : undefined;
  const warnings = report?.warnings ?? [];
  const hasWorkingCopy = report?.targets.some((each) => each.kind === "local");
  return (
    <tbody className="border-b border-rule last:border-0">
      {showProjectRows ? (
        <tr className="bg-steel/60">
          <td colSpan={COLUMNS} className="px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link
                href={`/projects/${encodeURIComponent(project.name)}`}
                className="title text-base text-ink no-underline hover:underline"
              >
                {project.name}
              </Link>
              <Mono className="text-muted-foreground">{project.repoPath}</Mono>
              {project.missing ? (
                <span className="inline-flex items-center gap-1 text-xs text-bad">
                  <AlertTriangle className="size-3.5" aria-hidden /> repository
                  missing
                </span>
              ) : null}
              {warnings.map((warning) => (
                <span
                  key={warning}
                  className="inline-flex items-center gap-1 text-xs text-warn"
                >
                  <AlertTriangle className="size-3.5" aria-hidden /> {warning}
                </span>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
      {status === undefined && !project.missing ? (
        <tr>
          <td colSpan={COLUMNS} className={cn(CELL, "text-muted-foreground")}>
            <span
              aria-hidden
              className="busy-dot mr-2 inline-block size-2 rounded-full bg-busy"
            />
            Reading status…
          </td>
        </tr>
      ) : null}
      {status && !status.ok ? (
        <tr>
          <td colSpan={COLUMNS} className={CELL}>
            <Failure failure={status.failure} />
          </td>
        </tr>
      ) : null}
      {project.missing ? (
        <tr>
          <td colSpan={COLUMNS} className={cn(CELL, "text-muted-foreground")}>
            The registered directory no longer exists.{" "}
            <Link
              href={`/projects/${encodeURIComponent(project.name)}/settings`}
            >
              Repoint or forget it.
            </Link>
          </td>
        </tr>
      ) : null}
      {report && !hasWorkingCopy ? (
        <tr>
          <td className={cn(CELL, "text-muted-foreground")}>
            <span className="italic">not started</span>
          </td>
          <td className={CELL}>Working copy</td>
          <td
            colSpan={COLUMNS - 3}
            className={cn(CELL, "text-muted-foreground")}
          >
            Runs the files on disk, without a deploy.
          </td>
          <td className={cn(CELL, "text-right")}>
            <div className="flex justify-end">
              <StartWorkingCopy project={project.name} />
            </div>
          </td>
        </tr>
      ) : null}
      {report?.targets.map((target) => {
        const problems = targetWarnings(target);
        return (
          <tr key={targetKey(target)} className="border-t border-rule/60">
            <td className={cn(CELL, "font-medium")}>
              <Link
                href={`/projects/${encodeURIComponent(project.name)}/logs?target=${encodeURIComponent(targetKey(target))}`}
                className="text-ink no-underline hover:underline"
                title="Logs"
              >
                {target.name}
              </Link>
            </td>
            <td className={cn(CELL, "whitespace-nowrap text-muted-foreground")}>
              {KIND_LABEL[target.kind]}
            </td>
            <td className={CELL}>
              <State value={target.state} />
              {problems.map((problem) => (
                <p key={problem} className="mt-1 text-xs text-warn">
                  {problem}
                </p>
              ))}
            </td>
            <td className={cn(CELL, "max-w-48 truncate")} title={target.branch}>
              {target.branch ?? (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td className={CELL}>
              {target.commit ? (
                <Mono title={target.commit}>{shortCommit(target.commit)}</Mono>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td className={cn(CELL, "max-w-64")}>
              {target.route ? (
                <a
                  href={routeUrl(target.route)}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all"
                >
                  {target.route}
                </a>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td className={CELL}>
              <Components components={target.components} />
            </td>
            <td className={cn(CELL, "text-right")}>
              <div className="flex justify-end">
                <TargetActions project={project.name} target={target} compact />
              </div>
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
/** Each component's name, state and port on one line, the way `rig status` prints them. */
function Components({
  components,
}: {
  components: readonly ComponentReport[];
}) {
  if (components.length === 0)
    return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {components.map((component) => (
        <li
          key={component.name}
          className="flex flex-wrap items-center gap-x-2 whitespace-nowrap"
        >
          <State value={component.state} className="text-xs" />
          <span className="text-xs">{component.name}</span>
          {component.port ? (
            <Mono className="text-muted-foreground">:{component.port}</Mono>
          ) : null}
          {component.pid ? (
            <Mono className="text-muted-foreground">pid {component.pid}</Mono>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
