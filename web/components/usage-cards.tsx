"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { ActivityResult } from "@/lib/types";
import {
  bytes,
  percent,
  timeLabel,
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

/** One series' card: its name, what it uses now in large type, its CPU and memory charts with median and peak, and the
 * latest things that happened to it. A series with nothing sampled in the range says so. */
export function SeriesCard({
  series,
  report,
  title,
  color,
  activity,
  markers,
  className,
}: {
  series: ChartSeries | undefined;
  report: ChartReport;
  title: ReactNode;
  color: string;
  activity: readonly Operation[];
  markers: readonly ChartMarker[];
  className?: string;
}) {
  return (
    <section className={cn(CARD, "flex min-w-0 flex-col gap-2 p-4", className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm font-semibold">{title}</div>
        <Now series={series} />
      </header>
      {series?.cpu.stats ? (
        <>
          <div className={EYEBROW}>CPU</div>
          <UsageChart
            report={report}
            layers={[{ key: series.key, label: "CPU", color, ...series.cpu }]}
            median={series.cpu.stats.median}
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
            median={series.memory.stats?.median}
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
      <RecentActivity operations={activity} />
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
export function RecentActivity({
  operations,
}: {
  operations: readonly Operation[];
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
            <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
              {timeLabel(Date.parse(operation.occurredAt) / 1000, "1h")}
            </span>
            <span className="min-w-0 truncate">
              {operation.action}
              {operation.target ? ` ${operation.target}` : ""}
              {operation.message ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {operation.message}
                </span>
              ) : null}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
