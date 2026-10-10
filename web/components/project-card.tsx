import Link from "next/link";
import { GitBranch, TriangleAlert } from "lucide-react";
import type { ProjectEntry } from "@/lib/board-rows";
import { orderedTargets, worstTone } from "@/lib/overview";
import { healthSummary, shortCommit, targetWarnings } from "@/lib/present";
import { projectHref, routeUrl, targetHref } from "@/lib/target";
import type { ComponentReport, TargetReport } from "@/lib/types";
import { Dot, KindTag, Mono, StatePill } from "./bits";
import { TargetActions } from "./target-actions";
import { cn } from "@/lib/utils";

/** One Project on the overview: its Targets, each with its state, hostname, revision, Services and
 * the actions its state calls for. A Project rigd could not report on says why instead. */
export function ProjectCard({ project, status }: ProjectEntry) {
  const href = projectHref(project.name);
  const targets = status?.ok ? orderedTargets(status.value.targets) : [];
  const tone = worstTone(targets.map((target) => target.state));
  return (
    <section className="flex flex-col overflow-hidden rounded-lg border border-rule bg-sheet shadow-xs">
      <header className="flex min-w-0 items-center gap-3 border-b border-rule px-4 py-3">
        <Dot
          value={
            project.missing
              ? "missing"
              : status && !status.ok
                ? "failed"
                : tone === "idle"
                  ? "stopped"
                  : tone === "good"
                    ? "running"
                    : tone === "busy"
                      ? "starting"
                      : tone === "warn"
                        ? "degraded"
                        : "failed"
          }
        />
        <Link
          href={href}
          className="title truncate text-base text-ink no-underline hover:underline"
        >
          {project.name}
        </Link>
        <Mono
          className="hidden min-w-0 truncate text-muted-foreground sm:inline"
          title={project.repoPath}
        >
          {project.repoPath}
        </Mono>
        <nav className="ml-auto flex shrink-0 items-center gap-3 text-xs">
          <Link
            href={`${href}/deployments`}
            className="text-muted-foreground hover:text-foreground"
          >
            Deployments
          </Link>
          <Link
            href={`${href}/logs`}
            className="text-muted-foreground hover:text-foreground"
          >
            Logs
          </Link>
          <Link
            href={`${href}/config`}
            className="text-muted-foreground hover:text-foreground"
          >
            Config
          </Link>
        </nav>
      </header>
      {project.missing ? (
        <Problem>
          The registered directory no longer exists.{" "}
          <Link href={`${href}/settings`}>Repoint or forget it</Link>.
        </Problem>
      ) : status && !status.ok ? (
        <Problem>
          {status.failure.code}: {status.failure.message}
        </Problem>
      ) : null}
      {status?.ok && targets.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No Target is on. Turn one on under <code>targets</code> in{" "}
          <Link href={`${href}/config`}>rig.yaml</Link>.
        </p>
      ) : null}
      {targets.length ? (
        <ul className="divide-y divide-rule/70">
          {targets.map((target) => (
            <TargetLine
              key={target.name}
              project={project.name}
              target={target}
            />
          ))}
        </ul>
      ) : null}
      {status?.ok && status.value.warnings?.length ? (
        <ul className="border-t border-rule bg-warn-fill/40 px-4 py-2 text-xs text-warn">
          {status.value.warnings.map((warning) => (
            <li key={warning} className="flex gap-1.5">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-1.5 px-4 py-3 text-sm text-bad">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
function TargetLine({
  project,
  target,
}: {
  project: string;
  target: TargetReport;
}) {
  const warnings = targetWarnings(target);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-2.5 md:grid-cols-[5.5rem_minmax(0,1.4fr)_minmax(0,1fr)_auto]">
      <div className="hidden md:block">
        <KindTag kind={target.kind} />
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={targetHref(project, target.name)}
            className="truncate font-medium text-ink no-underline hover:underline"
          >
            {target.name}
          </Link>
          <StatePill value={target.state} />
          {warnings.length ? (
            <span className="text-warn" title={warnings.join(" ")}>
              <TriangleAlert className="size-3.5" aria-hidden />
              <span className="sr-only">{warnings.join(" ")}</span>
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          {target.route ? (
            <a
              href={routeUrl(target.route)}
              target="_blank"
              rel="noreferrer"
              className="truncate"
              title={target.route}
            >
              {target.route}
            </a>
          ) : (
            <span>no hostname</span>
          )}
          <Revision target={target} className="md:hidden" />
        </div>
      </div>
      <div className="hidden min-w-0 flex-col gap-1 md:flex">
        <Revision target={target} />
        <Components components={target.components} />
      </div>
      <TargetActions project={project} target={target} layout="buttons" />
    </li>
  );
}
/** Where a Target's code comes from: its Branch and Commit, or the working copy. */
export function Revision({
  target,
  className,
}: {
  target: Pick<TargetReport, "kind" | "branch" | "commit">;
  className?: string;
}) {
  if (target.kind === "working")
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        working copy
      </span>
    );
  if (!target.branch && !target.commit)
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        not deployed
      </span>
    );
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
      title={[target.branch, target.commit].filter(Boolean).join(" @ ")}
    >
      <GitBranch className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{target.branch}</span>
      {target.commit ? (
        <Mono className="break-normal text-foreground">
          {shortCommit(target.commit)?.slice(0, 7)}
        </Mono>
      ) : null}
    </span>
  );
}
/** Each Service and Tool as a dot and its name, with the port and cached health in the tooltip. */
export function Components({
  components,
}: {
  components: readonly ComponentReport[];
}) {
  if (components.length === 0) return null;
  const now = new Date();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {components.map((component) => (
        <span
          key={component.name}
          className="inline-flex items-center gap-1.5"
          title={[
            component.state,
            healthSummary(component, now),
            component.port ? `port ${component.port}` : undefined,
            component.reason,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <Dot value={component.state} className="size-1.5" />
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
