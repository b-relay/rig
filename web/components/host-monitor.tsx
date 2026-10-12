"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { projectColor } from "@/lib/health";
import type { ActivityResult, DoctorReport } from "@/lib/types";
import {
  bytes,
  cardsOf,
  markersOf,
  percent,
  type ChartReport,
  type ChartSeries,
  type UsageRange,
} from "@/lib/usage";
import type { Failure as ReadFailure, Outcome } from "@/lib/outcome";
import { projectHref } from "@/lib/target";
import { Failure } from "./bits";
import { ProjectIcon } from "./project-icon";
import {
  DoctorList,
  FactRows,
  RunningOperations,
  SideCard,
  type Fact,
} from "./monitor-side";
import { UsageChart } from "./usage-chart";
import { CardGrid, CombinedCharts, CPU_FLOOR, SeriesCard } from "./usage-cards";
import { useUsage } from "./usage-live";

type Operation = ActivityResult["operations"][number];
const RIG_COLOR = "var(--idle)";

/** The Monitor page below its header. The side column holds rigd (with what Rig itself uses), Doctor, and Activity for
 * all Projects; on a phone rigd and Doctor sit side by side above the charts and Activity follows them. The main
 * column stacks every Project in one CPU and one memory chart, each Project's peak flagged where it happened and
 * Activity marked on the time axis, then a card per registered Project with its own charts and latest Activity. Live:
 * it reads the Host's report again after every sample; the side column stands even while that read fails. */
export function HostMonitor({
  initial,
  initialFailure,
  range,
  projects,
  operations,
  now,
  rigd,
  doctor,
  activity,
  controls,
}: {
  /** The report the page was rendered with; absent when that read failed, with `initialFailure` saying why. */
  initial?: ChartReport;
  initialFailure?: ReadFailure;
  range: UsageRange;
  /** Every registered Project, so one that never ran still has its card. */
  projects: readonly string[];
  operations: readonly Operation[];
  /** The page's render instant, for Activity's "ago". */
  now: number;
  /** rigd's facts (version, process, root, queue) and what it runs now; or why they could not be read. Data, not
   * elements, so the card renders them here. */
  rigd:
    | {
        readonly facts: readonly Fact[];
        readonly running: Parameters<typeof RunningOperations>[0]["operations"];
      }
    | { readonly failure: ReadFailure };
  /** Doctor's Host checks, or why they could not be read: data, so the card renders here. */
  doctor: Outcome<DoctorReport>;
  activity: ReactNode;
  /** rigd's own controls, under Activity. */
  controls?: ReactNode;
}) {
  const { report, failure } = useUsage(
    initial,
    { host: true, range },
    initialFailure,
  );
  const sampled =
    report?.series.filter((each) => each.series.scope === "project") ?? [];
  const rig = report?.series.find((each) => each.series.scope === "rig");
  const main = report ? (
    <div className="flex min-w-0 flex-col gap-4">
      <CombinedCharts
        title="All Projects"
        {...(failure && { failure: failure.message })}
        parts={[...sampled, ...(rig ? [rig] : [])].map((series) => ({
          series,
          label: series.series.project ?? "Rig itself",
          color: colorOf(series),
        }))}
        report={report}
        markers={markersOf(operations, report)}
        empty="Nothing has been sampled yet. Charts fill in within a few seconds of rigd starting."
      />
      <CardGrid>
        {cardsOf(
          projects.map((name) => ({ name })),
          sampled,
          (each) => ({ name: each.series.project! }),
        ).map((card) => {
          const own = operations.filter(
            (operation) => operation.project === card.name,
          );
          return (
            <SeriesCard
              key={card.key}
              series={card.series}
              report={report}
              color={`var(--chart-${projectColor(card.name)})`}
              title={
                <Link
                  href={`${projectHref(card.name)}/monitor`}
                  className="flex min-w-0 items-center gap-2 hover:underline"
                >
                  <ProjectIcon project={card.name} size="sm" />
                  <span className="truncate">{card.name}</span>
                </Link>
              }
              activity={own}
              markers={markersOf(own, report)}
              now={now}
            />
          );
        })}
      </CardGrid>
    </div>
  ) : (
    // Read again every second: the charts appear as soon as a read succeeds.
    <Failure failure={failure} />
  );
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <div className="grid grid-cols-2 items-start gap-3 lg:col-start-1 lg:row-start-1 lg:grid-cols-1 lg:gap-4">
        <SideCard
          title="rigd"
          aside={
            <>
              <span aria-hidden className="size-1.5 rounded-full bg-good" />
              running
            </>
          }
        >
          <div className="flex flex-col gap-2">
            {"failure" in rigd ? (
              <Failure failure={rigd.failure} />
            ) : (
              <>
                <FactRows rows={rigd.facts} />
                <RunningOperations operations={rigd.running} now={now} />
              </>
            )}
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 border-t pt-1.5 text-sm">
              <span className="text-muted-foreground">Rig itself</span>
              <span className="font-display tabular-nums">
                {rig?.now
                  ? `${percent(rig.now.cpuPercent)} · ${bytes(rig.now.memoryBytes)}`
                  : "–"}
              </span>
            </div>
            {report && rig?.cpu.peak ? (
              <UsageChart
                report={report}
                layers={[
                  {
                    key: rig.key,
                    label: "Rig itself",
                    color: RIG_COLOR,
                    ...rig.cpu,
                  },
                ]}
                format={percent}
                floor={CPU_FLOOR}
                height={44}
                axis={false}
              />
            ) : null}
          </div>
        </SideCard>
        {doctor.ok ? (
          <DoctorList report={doctor.value} />
        ) : (
          <SideCard title="Doctor">
            <Failure failure={doctor.failure} />
          </SideCard>
        )}
      </div>
      <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        {main}
      </div>
      <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-2">
        {activity}
        {controls}
      </div>
    </div>
  );
}

/** A Project wears its monogram's colour on every chart; Rig itself is the quiet grey. */
function colorOf(each: ChartSeries): string {
  return each.series.project
    ? `var(--chart-${projectColor(each.series.project)})`
    : RIG_COLOR;
}
