"use client";

import type { ReactNode } from "react";
import type { ActivityResult } from "@/lib/types";
import {
  bytes,
  percent,
  type ChartReport,
  type ChartSeries,
} from "@/lib/usage";
import { cn } from "@/lib/utils";
import { CARD, EYEBROW } from "./bits";
import { UsageChart, type ChartLayer } from "./usage-chart";
import { CPU_FLOOR, MEMORY_FLOOR, Now, SeriesCard } from "./usage-cards";
import { useUsage } from "./usage-live";
import { markersOf } from "@/lib/usage";

type Operation = ActivityResult["operations"][number];
/** Components take the chart colours in turn, starting away from the Project's own blue. */
const PALETTE = [2, 4, 1, 5, 3].map((n) => `var(--chart-${n})`);

/** A Project's Monitor tab below its Target chip. The side column holds the Project's Doctor (one line on a phone
 * while every check passes) and its Activity. The main column stacks the chosen Target's Services and Jobs in one CPU
 * and one memory chart, each component's peak flagged where it happened; with `all`, it stacks the Targets instead.
 * Then a card per Service and Job of that Target, or per Target, with its own charts and latest Activity. Live: it
 * reads the Project's report again after every sample. */
export function ProjectMonitor({
  project,
  initial,
  target,
  operations,
  doctor,
  activity,
}: {
  project: string;
  initial: ChartReport;
  /** The Target shown, by name, or `all`. */
  target: string;
  operations: readonly Operation[];
  doctor: ReactNode;
  activity: ReactNode;
}) {
  const { report, failure } = useUsage(initial, {
    project,
    range: initial.range,
  });
  const targetSeries = report.series.find(
    (each) => each.series.scope === "target" && each.series.target === target,
  );
  const total =
    target === "all"
      ? report.series.find((each) => each.series.scope === "project")
      : targetSeries;
  const parts =
    target === "all"
      ? report.series.filter((each) => each.series.scope === "target")
      : report.series.filter(
          (each) =>
            each.series.scope === "component" && each.series.target === target,
        );
  const colorOf = (index: number) => PALETTE[index % PALETTE.length]!;
  const layers = (measure: "cpu" | "memory"): ChartLayer[] =>
    parts.map((each, index) => ({
      key: each.key,
      label: nameOf(each),
      color: colorOf(index),
      ...each[measure],
    }));
  const relevant = operations.filter(
    (operation) => target === "all" || operation.target === target,
  );
  const markers = markersOf(relevant, report);
  const main = (
    <div className="flex min-w-0 flex-col gap-4">
      <section className={cn(CARD, "flex flex-col gap-2 p-4 sm:p-5")}>
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">
            All of{" "}
            <span className="font-mono font-medium">
              {target === "all" ? "every Target" : target}
            </span>
          </h2>
          {failure ? (
            <span className="text-xs text-warn">Not updating: {failure}</span>
          ) : (
            <Now series={total} />
          )}
        </header>
        {parts.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
            Nothing ran here in this range, so there is nothing to chart.
          </p>
        ) : (
          <>
            <div className={EYEBROW}>CPU · 100% is one core</div>
            <UsageChart
              report={report}
              layers={layers("cpu")}
              format={percent}
              floor={CPU_FLOOR}
              markers={markers}
              height={170}
            />
            <div className={EYEBROW}>Memory</div>
            <UsageChart
              report={report}
              layers={layers("memory")}
              format={bytes}
              floor={MEMORY_FLOOR}
              markers={markers}
              height={130}
            />
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {parts.map((each, index) => (
                <li key={each.key} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2.5 rounded-[3px]"
                    style={{ background: colorOf(index) }}
                  />
                  {nameOf(each)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <div className="grid gap-4 sm:grid-cols-2">
        {parts.map((each, index) => (
          <SeriesCard
            key={each.key}
            series={each}
            report={report}
            color={colorOf(index)}
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono">{nameOf(each)}</span>
                {each.series.componentKind ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    {each.series.componentKind}
                  </span>
                ) : null}
              </span>
            }
            // Activity names Targets, not Services, so only a Target's card lists its own; a Service's is in the feed.
            activity={
              each.series.scope === "target"
                ? relevant.filter(
                    (operation) => operation.target === each.series.target,
                  )
                : []
            }
            markers={[]}
            className={
              index === parts.length - 1 && parts.length % 2 === 1
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
      <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
        {doctor}
      </div>
      <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        {main}
      </div>
      <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-2">
        {activity}
      </div>
    </div>
  );
}

function nameOf(each: ChartSeries): string {
  return each.series.component ?? each.series.target ?? "?";
}
