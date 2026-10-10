import type { ReactNode } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Failure, KindTag, PageHeader, StatePill } from "@/components/bits";
import { Revision } from "@/components/project-card";
import { TargetTabs } from "@/components/project-tabs";
import { TargetActions } from "@/components/target-actions";
import { targetWarnings } from "@/lib/present";
import { projectHref, routeUrl } from "@/lib/target";
import { settled } from "@/server/settled";
import { target } from "@/server/target";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { name, target: shown } = await params;
  return { title: `${shown} · ${name}` };
}
/** One Target's own sections: its state, hostname and revision on top, with its actions. */
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
  const { project, target: report } = read.value;
  const warnings = targetWarnings(report);
  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href="/" className="text-muted-foreground">
              Projects
            </Link>{" "}
            /{" "}
            <Link
              href={projectHref(project.name)}
              className="text-muted-foreground"
            >
              {project.name}
            </Link>{" "}
            /
          </>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {report.name}
            <KindTag kind={report.kind} />
            <StatePill value={report.state} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {report.route ? (
              <a href={routeUrl(report.route)} target="_blank" rel="noreferrer">
                {report.route}
              </a>
            ) : (
              <span>no hostname</span>
            )}
            <Revision target={report} />
          </span>
        }
        actions={
          <TargetActions
            project={project.name}
            target={report}
            layout="buttons"
            stacked
          />
        }
      />
      {warnings.length ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-warn/40 bg-warn-fill px-4 py-2 text-sm text-warn">
          {warnings.map((warning) => (
            <li key={warning} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
      <TargetTabs project={project.name} target={report.name} />
      {children}
    </>
  );
}
