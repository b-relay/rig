"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { ActivityResult } from "@/lib/types";
import { ago } from "@/lib/present";
import {
  bytes,
  percent,
  type ChartReport,
  type ChartSeries,
} from "@/lib/usage";
import { cn } from "@/lib/utils";
import { CARD, Dot, EYEBROW } from "./bits";
import { UsageChart, type ChartMarker } from "./usage-chart";

type Operation = ActivityResult["operations"][number];

/** The scale's lowest top for CPU (a quarter of a core) and memory (64 MB): an idle chart is not a scale of noise. */
export const CPU_FLOOR = 25;
export const MEMORY_FLOOR = 64e6;

/** One part of a combined chart: a series, its name and its colour. */
export interface ChartPart {
  readonly series: ChartSeries;
  readonly label: string;
  readonly color: string;
}

/** A Monitor page's headline card: every part stacked in one CPU and one memory chart, each part's peak flagged and
 * `markers` on the time axis, with a legend. `failure` says why it stopped updating; with no parts it says `empty`. */
export function CombinedCharts({
  title,
  aside,
  failure,
  parts,
  report,
  markers,
  empty,
}: {
  title: ReactNode;
  /** What the parts use now, beside the title. */
  aside?: ReactNode;
  failure?: string;
  parts: readonly ChartPart[];
  report: ChartReport;
  markers: readonly ChartMarker[];
  empty: string;
}) {
  const layers = (measure: "cpu" | "memory") =>
    parts.map(({ series, label, color }) => ({
      key: series.key,
      label,
      color,
      ...series[measure],
    }));
  return (
    <section className={cn(CARD, "flex flex-col gap-2 p-4 sm:p-5")}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {failure ? (
          <span className="text-xs text-warn">Not updating: {failure}</span>
        ) : (
          aside
        )}
      </header>
      {parts.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
          {empty}
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
            {parts.map(({ series, label, color }) => (
              <li key={series.key} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2.5 rounded-[3px]"
                  style={{ background: color }}
                />
                {label}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Cards two to a row from the small layout up; an odd last card spans the row, so no gap is left beside it. */
export function CardGrid({ children }: { children: readonly ReactNode[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 sm:[&>*:last-child:nth-child(odd)]:col-span-2">
      {children}
    </div>
  );
}

/** One series' card: its name, what it uses now in large type, its CPU and memory charts with median and peak, and the
 * latest things that happened to it. A series with nothing sampled in the range, or none yet, says so. */
export function SeriesCard({
  series,
  report,
  title,
  color,
  activity,
  markers,
  now,
}: {
  series: ChartSeries | undefined;
  report: ChartReport;
  title: ReactNode;
  color: string;
  activity: readonly Operation[];
  markers: readonly ChartMarker[];
  /** The instant Activity's "ago" is counted from, the page's render, so the server and the browser agree. */
  now: number;
}) {
  return (
    <section className={cn(CARD, "flex min-w-0 flex-col gap-2 p-4")}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm font-semibold">{title}</div>
        <Now series={series} />
      </header>
      {series?.cpu.peak ? (
        <>
          <div className={EYEBROW}>CPU</div>
          <UsageChart
            report={report}
            layers={[{ key: series.key, label: "CPU", color, ...series.cpu }]}
            median={series.cpu.median}
            format={percent}
            floor={CPU_FLOOR}
            markers={markers}
            height={76}
            axis={false}
          />
          <div className={EYEBROW}>Memory</div>
          <UsageChart
            report={report}
            layers={[
              {
                key: series.key,
                label: "Memory",
                color: "var(--idle)",
                ...series.memory,
              },
            ]}
            median={series.memory.median}
            format={bytes}
            floor={MEMORY_FLOOR}
            height={56}
            axis={false}
          />
        </>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          Nothing sampled in this range.
        </p>
      )}
      <RecentActivity operations={activity} now={now} />
    </section>
  );
}

/** What a series uses now, as the card's headline, with a live dot while it runs. */
export function Now({ series }: { series: ChartSeries | undefined }) {
  if (!series?.now)
    return <span className="text-xs text-muted-foreground">not running</span>;
  return (
    <span className="flex items-baseline gap-2 font-display tabular-nums">
      <span
        aria-hidden
        className="busy-dot size-1.5 self-center rounded-full bg-good"
      />
      <span className="text-base font-semibold">
        {percent(series.now.cpuPercent)}
      </span>
      <span className="text-xs text-muted-foreground">
        {bytes(series.now.memoryBytes)}
      </span>
    </span>
  );
}

/** The latest two things that happened, under a card's charts. */
function RecentActivity({
  operations,
  now,
}: {
  operations: readonly Operation[];
  now: number;
}) {
  const latest = [...operations]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 2);
  if (latest.length === 0) return null;
  return (
    <ol className="mt-1 flex flex-col border-t pt-1.5">
      {latest.map((operation) => (
        <li key={operation.id}>
          <Link
            href={`/activity?operation=${encodeURIComponent(operation.id)}`}
            className="flex items-baseline gap-2 rounded-md px-1 py-1 text-xs hover:bg-accent"
          >
            <Dot value={operation.outcome} className="size-1.5 self-center" />
            <span className="min-w-0 flex-1 truncate">
              {operation.action}
              {operation.target ? ` ${operation.target}` : ""}
              {operation.message ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {operation.message}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {ago(operation.occurredAt, now)}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
