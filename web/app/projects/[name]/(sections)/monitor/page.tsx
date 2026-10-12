import { attempt } from "@/lib/outcome";
import type { ActivityResult, DoctorReport } from "@/lib/types";
import {
  bytes,
  chartReport,
  percent,
  presetWindow,
  rangeOf,
  type ChartReport,
} from "@/lib/usage";
import { projectHref } from "@/lib/target";
import { read } from "@/server/daemon";
import { project } from "@/server/project";
import { projectStatus } from "@/server/status";
import { Failure } from "@/components/bits";
import { ActivityFeed, DoctorList, SideCard } from "@/components/monitor-side";
import { ProjectMonitor } from "@/components/project-monitor";
import { TargetChip, type ChipTarget } from "@/components/target-chip";
import { RangeTabs } from "@/components/usage-range";

/** One Project's CPU and memory, Target by Target, beside its Doctor checks and its Activity. `?target=` picks the
 * Target (`all` for every one together; stable when it has history, else the first Target), `?range=` the span. */
export default async function ProjectMonitorPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ target?: string; range?: string }>;
}) {
  const found = await project(params);
  const query = await searchParams;
  const range = rangeOf(query.range);
  const [usage, doctor, activity, status] = await Promise.all([
    attempt(
      read({
        action: "monitor",
        project: found.name,
        window: presetWindow(range, Date.now()),
      }),
    ),
    attempt(read({ action: "doctor", project: found.name })),
    attempt(read({ action: "activity", project: found.name })),
    projectStatus(found.name),
  ]);
  if (!usage.ok) return <Failure failure={usage.failure} />;
  const report = chartReport(usage.value, range);
  const hrefOf = (next: string) =>
    `${projectHref(found.name)}/monitor?${new URLSearchParams({ target: next, range })}`;
  const targets = chipTargets(
    report,
    status.ok ? status.value.targets : [],
    hrefOf,
  );
  const target =
    query.target === "all" || targets.some((t) => t.name === query.target)
      ? query.target!
      : (targets.find((t) => t.name === "stable" && t.detail)?.name ??
        targets[0]?.name ??
        "all");
  const operations = activity.ok
    ? (activity.value as ActivityResult).operations
    : [];
  const total = report.series.find((each) => each.series.scope === "project");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TargetChip
          current={target}
          targets={targets}
          allHref={hrefOf("all")}
          {...(total?.now && {
            allDetail: `${percent(total.now.cpuPercent)} · ${bytes(total.now.memoryBytes)}`,
          })}
        />
        <RangeTabs current={range} query={{ target }} />
      </div>
      <ProjectMonitor
        project={found.name}
        initial={report}
        target={target}
        operations={operations}
        doctor={
          doctor.ok ? (
            <DoctorList report={doctor.value as DoctorReport} fold />
          ) : (
            <SideCard title="Doctor">
              <Failure failure={doctor.failure} />
            </SideCard>
          )
        }
        activity={
          <ActivityFeed
            operations={operations.filter(
              (operation) => target === "all" || operation.target === target,
            )}
            showProject={false}
            now={Date.now()}
            scope={
              <span className="font-mono">
                {target === "all" ? "all targets" : target}
              </span>
            }
            allHref={`${projectHref(found.name)}/activity`}
          />
        }
      />
    </div>
  );
}

/** Pure: the Targets the chip offers: every Target the Project has now, in status order, and any whose history the
 * range still holds (a destroyed Preview), each with what it uses now. */
function chipTargets(
  report: ChartReport,
  current: readonly { name: string; state: string }[],
  hrefOf: (target: string) => string,
): ChipTarget[] {
  const now = new Map(
    report.series
      .filter((each) => each.series.scope === "target")
      .map((each) => [each.series.target!, each.now]),
  );
  const names = [
    ...current.map((target) => target.name),
    ...[...now.keys()].filter(
      (name) => !current.some((target) => target.name === name),
    ),
  ];
  return names.map((name) => {
    const usage = now.get(name);
    return {
      name,
      state:
        current.find((target) => target.name === name)?.state ?? "destroyed",
      href: hrefOf(name),
      ...(usage && {
        detail: `${percent(usage.cpuPercent)} · ${bytes(usage.memoryBytes)}`,
      }),
    };
  });
}
