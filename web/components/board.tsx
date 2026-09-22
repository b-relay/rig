import Link from "next/link";
import { Suspense } from "react";
import { TriangleAlert } from "lucide-react";
import { attempt } from "@/lib/outcome";
import { KIND_LABEL, shortCommit, targetWarnings, toneOf } from "@/lib/present";
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
  "px-3 py-1.5 text-left text-[11px] font-medium tracking-wide uppercase text-muted-foreground whitespace-nowrap";
const CELL = "px-3 py-1.5 align-middle whitespace-nowrap";
const DASH = <span className="text-muted-foreground/70">–</span>;
/** Every Target on this Host in one table, one line each, grouped by Project. Each Project's
 * rows stream in as its status arrives, so a slow Project never holds the others back. */
export function Board({
  projects,
  showProjectRows = true,
}: {
  projects: readonly Project[];
  showProjectRows?: boolean;
}) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0 sm:rounded-md sm:border sm:border-rule sm:bg-sheet">
      <table className="w-full min-w-[60rem] text-[13px] leading-5">
        <thead className="border-b border-rule">
          <tr>
            <th className={HEAD}>Target</th>
            <th className={HEAD}>Kind</th>
            <th className={HEAD}>State</th>
            <th className={HEAD}>Branch</th>
            <th className={HEAD}>Commit</th>
            <th className={HEAD}>Route</th>
            <th className={HEAD}>Components</th>
            <th className={cn(HEAD, "w-10")}>
              <span className="sr-only">Actions</span>
            </th>
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
  const href = `/projects/${encodeURIComponent(project.name)}`;
  return (
    <tbody className="border-b border-rule last:border-0">
      {showProjectRows ? (
        <tr className="bg-muted/50">
          <td colSpan={COLUMNS} className="px-3 py-1.5">
            <div className="flex items-center gap-3">
              <Link
                href={href}
                className="title text-sm text-ink no-underline hover:underline"
              >
                {project.name}
              </Link>
              <Mono
                className="max-w-[40ch] truncate break-normal text-muted-foreground"
                title={project.repoPath}
              >
                {project.repoPath}
              </Mono>
              {project.missing ? (
                <Warning tone="bad">repository missing</Warning>
              ) : null}
              {warnings.map((warning) => (
                <Warning key={warning} tone="warn">
                  {warning}
                </Warning>
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
          <td colSpan={COLUMNS} className="px-3 py-2">
            <Failure failure={status.failure} />
          </td>
        </tr>
      ) : null}
      {project.missing ? (
        <tr>
          <td colSpan={COLUMNS} className={cn(CELL, "text-muted-foreground")}>
            The registered directory no longer exists.{" "}
            <Link href={`${href}/settings`}>Repoint or forget it.</Link>
          </td>
        </tr>
      ) : null}
      {report && !hasWorkingCopy ? (
        <tr className="border-t border-rule/60">
          <td className={cn(CELL, "text-muted-foreground italic")}>
            not started
          </td>
          <td className={cn(CELL, "text-muted-foreground")}>Working copy</td>
          <td
            colSpan={COLUMNS - 3}
            className={cn(CELL, "text-muted-foreground")}
          >
            Runs the files on disk, without a deploy.
          </td>
          <td className={cn(CELL, "text-right")}>
            <StartWorkingCopy project={project.name} compact />
          </td>
        </tr>
      ) : null}
      {report?.targets.map((target) => {
        const problems = targetWarnings(target);
        return (
          <tr
            key={targetKey(target)}
            className="border-t border-rule/60 hover:bg-muted/30"
          >
            <td className={cn(CELL, "font-medium")}>
              <Link
                href={`${href}/logs?target=${encodeURIComponent(targetKey(target))}`}
                className="text-ink no-underline hover:underline"
                title="Logs"
              >
                {target.name}
              </Link>
            </td>
            <td className={cn(CELL, "text-muted-foreground")}>
              {KIND_LABEL[target.kind]}
            </td>
            <td className={CELL}>
              <span className="inline-flex items-center gap-2">
                <State value={target.state} />
                {problems.length ? (
                  <Warning tone="warn" iconOnly>
                    {problems.join(" ")}
                  </Warning>
                ) : null}
              </span>
            </td>
            <td className={cn(CELL, "max-w-48 truncate")} title={target.branch}>
              {target.branch ?? DASH}
            </td>
            <td className={CELL}>
              {target.commit ? (
                <Mono className="break-normal" title={target.commit}>
                  {shortCommit(target.commit)?.slice(0, 7)}
                </Mono>
              ) : (
                DASH
              )}
            </td>
            <td className={cn(CELL, "max-w-72 truncate")} title={target.route}>
              {target.route ? (
                <a
                  href={routeUrl(target.route)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {target.route}
                </a>
              ) : (
                DASH
              )}
            </td>
            <td className={CELL}>
              <Components components={target.components} />
            </td>
            <td className={cn(CELL, "text-right")}>
              <TargetActions project={project.name} target={target} />
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
/** A warning in the row it belongs to: a word or two, or the icon alone with the words on hover. */
function Warning({
  tone,
  iconOnly = false,
  children,
}: {
  tone: "warn" | "bad";
  iconOnly?: boolean;
  children: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs",
        tone === "bad" ? "text-bad" : "text-warn",
      )}
      title={children}
    >
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      <span className={cn("truncate", iconOnly ? "sr-only" : "max-w-[48ch]")}>
        {children}
      </span>
    </span>
  );
}
/** Each component on the one line: a state dot, its name and its port, the way `rig status` prints them. */
function Components({
  components,
}: {
  components: readonly ComponentReport[];
}) {
  if (components.length === 0) return DASH;
  return (
    <span className="inline-flex items-center gap-3">
      {components.map((component) => (
        <span
          key={component.name}
          className="inline-flex items-center gap-1.5"
          title={[
            component.state,
            component.pid ? `pid ${component.pid}` : undefined,
            component.reason,
          ]
            .filter(Boolean)
            .join(", ")}
        >
          <span
            aria-hidden
            className={cn("size-2 rounded-full", DOT[toneOf(component.state)])}
          />
          <span className="sr-only">{component.state}</span>
          {component.name}
          {component.port ? (
            <Mono className="break-normal text-muted-foreground">
              :{component.port}
            </Mono>
          ) : null}
        </span>
      ))}
    </span>
  );
}
const DOT = {
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  busy: "bg-busy busy-dot",
  idle: "bg-muted-ink/60",
};
