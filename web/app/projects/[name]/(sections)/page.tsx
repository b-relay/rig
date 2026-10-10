import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import {
  Dot,
  Empty,
  Failure,
  KindTag,
  Mono,
  StatePill,
} from "@/components/bits";
import { Revision } from "@/components/project-card";
import { TargetActions } from "@/components/target-actions";
import { orderedTargets } from "@/lib/overview";
import { healthSummary, targetWarnings } from "@/lib/present";
import { routeUrl, targetHref } from "@/lib/target";
import { componentPorts } from "@/lib/target-detail";
import type { TargetReport } from "@/lib/types";
import { project } from "@/server/project";
import { projectStatus } from "@/server/status";

/** The Project's Targets as cards: each with its state, hostname, revision, Services and actions. */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  if (found.missing)
    return (
      <Empty>
        The registered directory no longer exists.{" "}
        <Link href={`/projects/${encodeURIComponent(found.name)}/settings`}>
          Repoint or forget it
        </Link>
        .
      </Empty>
    );
  const status = await projectStatus(found.name);
  if (!status.ok) return <Failure failure={status.failure} />;
  const targets = orderedTargets(status.value.targets);
  const now = new Date();
  return (
    <>
      {status.value.warnings?.map((warning) => (
        <p key={warning} className="flex gap-2 text-sm text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {warning}
        </p>
      ))}
      {targets.length === 0 ? (
        <Empty>
          No Target is on. Turn one on under <code>targets</code> in the{" "}
          <Link href={`/projects/${encodeURIComponent(found.name)}/config`}>
            config
          </Link>
          .
        </Empty>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {targets.map((target) => (
          <TargetCard
            key={target.name}
            project={found.name}
            target={target}
            now={now}
          />
        ))}
      </div>
    </>
  );
}
function TargetCard({
  project,
  target,
  now,
}: {
  project: string;
  target: TargetReport;
  now: Date;
}) {
  const warnings = targetWarnings(target);
  return (
    <section className="flex flex-col overflow-hidden rounded-lg border border-rule bg-sheet shadow-xs">
      <header className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-3">
        <KindTag kind={target.kind} />
        <Link
          href={targetHref(project, target.name)}
          className="min-w-0 truncate font-semibold text-ink no-underline hover:underline"
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
        <div className="ml-auto">
          <TargetActions
            project={project}
            target={target}
            layout="buttons"
            compact
          />
        </div>
      </header>
      <div className="flex flex-col gap-1 border-b border-rule/70 px-4 py-2.5 text-xs text-muted-foreground">
        {target.route ? (
          <a
            href={routeUrl(target.route)}
            target="_blank"
            rel="noreferrer"
            className="truncate text-sm"
          >
            {target.route}
          </a>
        ) : (
          <span className="text-sm">no hostname</span>
        )}
        <Revision target={target} />
      </div>
      <ul className="flex flex-col divide-y divide-rule/60 text-[13px]">
        {target.components.map((component) => {
          const health = healthSummary(component, now);
          return (
            <li
              key={component.name}
              className="flex items-center gap-2 px-4 py-2"
            >
              <Dot value={component.state} />
              <span className="font-medium">{component.name}</span>
              {componentPorts(component).map(({ name, port }) => (
                <Mono
                  key={name ?? port}
                  className="break-normal text-muted-foreground"
                >
                  :{port}
                </Mono>
              ))}
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {health ?? component.state}
                {component.restarts ? (
                  <span className="ml-2 text-warn">
                    {component.restarts} recent restart
                    {component.restarts === 1 ? "" : "s"}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
