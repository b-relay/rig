import type { ReactNode } from "react";
import Link from "next/link";
import { Globe } from "lucide-react";
import {
  CARD,
  Dot,
  Failure,
  KindTag,
  PageHeader,
  Revision,
  StatePill,
  Warning,
} from "@/components/bits";
import { ProjectIcon } from "@/components/project-icon";
import { TargetTabs } from "@/components/project-tabs";
import { TargetActions } from "@/components/target-actions";
import { targetWarnings } from "@/lib/present";
import { projectHref, routeUrl } from "@/lib/target";
import { settled } from "@/server/settled";
import { target } from "@/server/target";
import { cn } from "@/lib/utils";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { name, target: shown } = await params;
  return { title: `${shown} · ${name}` };
}
/** One Target's own sections under its card: state, name and role, revision and hostname, and its
 * actions, as the matrix shows it. */
export default async function TargetLayout({
  params,
  children,
}: {
  params: Promise<{ name: string; target: string }>;
  children: ReactNode;
}) {
  const read = await settled(target(params));
  if (!read.ok)
    return (
      <>
        <PageHeader title={(await params).target} />
        <Failure failure={read.failure} />
      </>
    );
  const { project, target: report, status } = read.value;
  const warnings = targetWarnings(report);
  const stable = status.targets.find((each) => each.kind === "stable");
  return (
    <>
      <div className="flex flex-col gap-3">
        <Link
          href={projectHref(project.name)}
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground no-underline hover:text-foreground"
        >
          <ProjectIcon
            project={project.name}
            favicon={stable?.route !== undefined}
            size="sm"
          />
          {project.name}
        </Link>
        <section
          className={cn(
            CARD,
            "flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5",
          )}
        >
          <div className="flex min-w-0 flex-col gap-2.5">
            <h1 className="flex min-w-0 flex-wrap items-center gap-2.5 text-xl leading-tight font-semibold tracking-tight sm:text-2xl">
              <Dot value={report.state} className="size-2.5" />
              <span className="min-w-0 truncate">{report.name}</span>
              {report.name === report.kind ? null : (
                <KindTag kind={report.kind} />
              )}
              <StatePill value={report.state} />
            </h1>
            <div className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground sm:flex-row sm:items-center sm:gap-5">
              <Revision target={report} className="text-sm" />
              <span className="flex min-w-0 items-center gap-1.5">
                <Globe className="size-3.5 shrink-0" aria-hidden />
                {report.route ? (
                  <a
                    href={routeUrl(report.route)}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate"
                  >
                    {report.route}
                  </a>
                ) : (
                  <span>
                    {report.kind === "working" ? "loopback only" : "no domain"}
                  </span>
                )}
              </span>
            </div>
            {warnings.length ? (
              <div className="flex flex-col gap-1">
                {warnings.map((warning) => (
                  <Warning key={warning}>{warning}</Warning>
                ))}
              </div>
            ) : null}
          </div>
          <div className="shrink-0">
            <TargetActions
              project={project.name}
              target={report}
              layout="buttons"
              stacked
            />
          </div>
        </section>
      </div>
      <TargetTabs project={project.name} target={report.name} />
      {children}
    </>
  );
}
