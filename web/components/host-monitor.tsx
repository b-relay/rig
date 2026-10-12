"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { projectColor } from "@/lib/health";
import type { ActivityResult } from "@/lib/types";
import {
  bytes,
  percent,
  type ChartReport,
  type ChartSeries,
} from "@/lib/usage";
import { projectHref } from "@/lib/target";
import { cn } from "@/lib/utils";
import { CARD, EYEBROW } from "./bits";
import { ProjectIcon } from "./project-icon";
import { UsageChart, type ChartLayer } from "./usage-chart";
import { CPU_FLOOR, MEMORY_FLOOR, SeriesCard } from "./usage-cards";
import { useUsage } from "./usage-live";
import { markersOf } from "@/lib/usage";
import { SideCard } from "./monitor-side";

type Operation = ActivityResult["operations"][number];
const RIG_COLOR = "var(--idle)";

/** The Monitor page below its header. The side column holds rigd (with what Rig itself uses), Doctor, and Activity for
 * all Projects; on a phone rigd and Doctor sit side by side above the charts and Activity follows them. The main
 * column stacks every Project in one CPU and one memory chart, each Project's peak flagged where it happened and
 * Activity marked on the time axis, then a card per Project with its own charts and latest Activity; an odd last card
 * spans the row. Live: it reads the Host's report again after every sample. */
export function HostMonitor({
  initial,
  operations,
  rigd,
  doctor,
  activity,
  controls,
}: {
  initial: ChartReport;
  operations: readonly Operation[];
  /** rigd's facts: version, uptime, queue. */
  rigd: ReactNode;
  doctor: ReactNode;
  activity: ReactNode;
  /** rigd's own controls, under Activity. */
  controls?: ReactNode;
}) {
  const { report, failure } = useUsage(initial, {
    host: true,
    range: initial.range,
  });
  const projects = report.series.filter(
    (each) => each.series.scope === "project",
  );
  const rig = report.series.find((each) => each.series.scope === "rig");
  const parts = [...projects, ...(rig ? [rig] : [])];
  const layer = (each: ChartSeries, measure: "cpu" | "memory"): ChartLayer => ({
    key: each.key,
    label: each.series.project ?? "Rig itself",
    color: colorOf(each),
    ...each[measure],
  });
  const markers = markersOf(operations, report);
  const main = (
    <div className="flex min-w-0 flex-col gap-4">
      <section className={cn(CARD, "flex flex-col gap-2 p-4 sm:p-5")}>
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">All Projects</h2>
          {failure ? (
            <span className="text-xs text-warn">Not updating: {failure}</span>
          ) : null}
        </header>
        {parts.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
            Nothing has been sampled yet. Charts fill in within a few seconds of
            rigd starting.
          </p>
        ) : (
          <>
            <div className={EYEBROW}>CPU · 100% is one core</div>
            <UsageChart
              report={report}
              layers={parts.map((each) => layer(each, "cpu"))}
              format={percent}
              floor={CPU_FLOOR}
              markers={markers}
              height={170}
            />
            <div className={EYEBROW}>Memory</div>
            <UsageChart
              report={report}
              layers={parts.map((each) => layer(each, "memory"))}
              format={bytes}
              floor={MEMORY_FLOOR}
              markers={markers}
              height={130}
            />
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {parts.map((each) => (
                <li key={each.key} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2.5 rounded-[3px]"
                    style={{ background: colorOf(each) }}
                  />
                  {each.series.project ?? "Rig itself"}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <div className="grid gap-4 sm:grid-cols-2">
        {projects.map((each, index) => (
          <SeriesCard
            key={each.key}
            series={each}
            report={report}
            color={colorOf(each)}
            title={
              <Link
                href={`${projectHref(each.series.project!)}/monitor`}
                className="flex min-w-0 items-center gap-2 hover:underline"
              >
                <ProjectIcon project={each.series.project!} size="sm" />
                <span className="truncate">{each.series.project}</span>
              </Link>
            }
            activity={operations.filter(
              (operation) => operation.project === each.series.project,
            )}
            markers={markersOf(
              operations.filter(
                (operation) => operation.project === each.series.project,
              ),
              report,
            )}
            className={
              index === projects.length - 1 && projects.length % 2 === 1
                ? "sm:col-span-2"
                : undefined
            }
          />
        ))}
      </div>
    </div>
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
          {rigd}
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 border-t pt-1.5 text-sm">
            <span className="text-muted-foreground">Rig itself</span>
            <span className="font-display tabular-nums">
              {rig?.now
                ? `${percent(rig.now.cpuPercent)} · ${bytes(rig.now.memoryBytes)}`
                : "–"}
            </span>
          </div>
          {rig?.cpu.stats ? (
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
        </SideCard>
        {doctor}
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
