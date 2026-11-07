import type { UsageSample } from "../domain/usage-sample";
import {
  chartOf,
  type UsagePoint,
  type UsageSummary,
  type UsageWindow,
} from "../domain/usage-summary";
import {
  seriesKey,
  type RecordedMinute,
  type SeriesFilter,
  type UsageHistory,
  type UsageSeries,
} from "./usage-history";
import {
  heldIn,
  overlaid,
  summarizedSpans,
  type SeriesSpans,
} from "./usage-overlay";
import {
  usageReportPlan,
  type SpanRange,
  type UsageReportPlan,
} from "./usage-report-plan";
import type { LatestSample, UsageSnapshot } from "./usage-sampler";

/** One series of a usage report. */
export interface UsageReportSeries {
  readonly series: UsageSeries;
  /** The newest sample, when it is from the last couple of sampling intervals: absent once the series stops running. */
  readonly now?: UsageSample;
  /** CPU and memory over the whole window. */
  readonly summary: UsageSummary;
  readonly points: readonly UsagePoint[];
}

/** What a scope used over a window, for `rig monitor` and the dashboard's Monitor pages. */
export interface UsageReport {
  /** The window asked for, in Unix seconds; `until` absent for a live window ending now. */
  readonly since: number;
  readonly until?: number;
  /** Unix seconds: the first point's start, and the end of the last. */
  readonly from: number;
  readonly to: number;
  /** Seconds per point. */
  readonly step: number;
  /** How often rigd samples, in seconds: 1 with the native reader, 5 with the `ps` fallback. */
  readonly sampledEvery: number;
  readonly series: readonly UsageReportSeries[];
}

/** Monitor's reads and removals, as rigd's runtime uses them. */
export interface UsageMonitor {
  /** What `filter` used over `window`. */
  report(request: {
    readonly filter: SeriesFilter;
    readonly window: UsageWindow;
  }): Promise<UsageReport>;
  /** Removes all of a Project's history, buffered or stored, as `rig forget` does. */
  forget(projectId: string): Promise<void>;
}

/** The usage report for `filter` over `window`, in steps sized to the window (about 360 points): stored history with
 * the minutes the sampler holds laid over it, so the chart reaches the current second. `usageReportPlan` sizes the
 * window, `overlaid` lays the held minutes over what is stored, and `reportSeries` charts and orders the series;
 * `tests/usage-sampler.test.ts` covers the whole report. */
export async function usageReport(input: {
  readonly filter: SeriesFilter;
  readonly window: UsageWindow;
  /** Milliseconds since the Unix epoch. */
  readonly now: number;
  /** Unix seconds from which detail retention keeps 1-second detail now; the report also allows for what is stored. */
  readonly detailSince: number;
  readonly sampledEvery: number;
  readonly history: UsageHistory;
  readonly snapshot: UsageSnapshot;
}): Promise<UsageReport> {
  const nowSecond = Math.floor(input.now / 1000);
  const plan = usageReportPlan({
    since: input.window.since,
    until: input.window.until,
    nowSecond,
    // Detail retention may have grown since the last prune; the minutes that lost their seconds have lost them all the same.
    detailSince: Math.max(input.detailSince, await input.history.detailFrom()),
  });
  const held = input.snapshot.pending.filter((minute) =>
    selected(minute.series, input.filter),
  );
  const read = (range: SpanRange) =>
    spansIn({ history: input.history, filter: input.filter, held, range });
  const chart = await read(plan.chart);
  const boundaries = await Promise.all(
    plan.boundaries.map(async (start) => ({
      start,
      seconds: await read({
        from: start,
        to: start + 60,
        resolution: "second",
      }),
    })),
  );
  return {
    since: plan.since,
    ...(input.window.until !== undefined && { until: input.window.until }),
    from: plan.chart.from,
    to: plan.chart.to,
    step: plan.step,
    sampledEvery: input.sampledEvery,
    series: reportSeries({
      plan,
      chart,
      boundaries,
      fresh: input.snapshot.latest.filter(
        (latest) =>
          selected(latest.series, input.filter) &&
          latest.at >= nowSecond - 2 * input.sampledEvery,
      ),
    }),
  };
}

/** Each selected series' spans in `range`: what is stored there, with the held minutes in it laid over it. */
async function spansIn(input: {
  readonly history: UsageHistory;
  readonly filter: SeriesFilter;
  /** The held minutes of the selected series. */
  readonly held: readonly RecordedMinute[];
  readonly range: SpanRange;
}): Promise<Map<string, SeriesSpans>> {
  const { history, filter, range } = input;
  const held = heldIn(input.held, range);
  const stored = await history.read({
    filter,
    from: range.from,
    to: range.to,
    detail: range.resolution === "second",
  });
  if (range.resolution === "second")
    return overlaid({ resolution: "second", stored, held });
  // A held minute replaces its stored minute, so the stored seconds of the held minutes are read to merge into them.
  const storedSeconds =
    held.length === 0
      ? []
      : await history.read({
          filter,
          from: Math.min(...held.map((minute) => minute.minute)) * 60,
          to: (Math.max(...held.map((minute) => minute.minute)) + 1) * 60,
          detail: true,
        });
  return overlaid({ resolution: "minute", stored, storedSeconds, held });
}

/** Pure: the report's series, ordered as the pages list them: the Host, Rig itself and Projects by name for the Host;
 * the Project, then its Targets, then their Components, for a Project. Each series in `chart` is charted over the
 * plan, its summary reading whatever seconds of the `boundaries` minutes it has; a series with a `fresh` sample (the
 * newest of the last couple of sampling intervals) carries it as `now`, and is listed even with no spans. */
export function reportSeries(input: {
  readonly plan: UsageReportPlan;
  readonly chart: ReadonlyMap<string, SeriesSpans>;
  readonly boundaries: readonly {
    readonly start: number;
    readonly seconds: ReadonlyMap<string, SeriesSpans>;
  }[];
  readonly fresh: readonly LatestSample[];
}): UsageReportSeries[] {
  const { plan } = input;
  const entries = new Map(input.chart);
  const fresh = new Map<string, UsageSample>();
  for (const latest of input.fresh) {
    const key = seriesKey(latest.series);
    if (!entries.has(key))
      entries.set(key, { series: latest.series, spans: [] });
    fresh.set(key, latest.sample);
  }
  return [...entries.entries()]
    .map(([key, { series, spans }]): UsageReportSeries => {
      const now = fresh.get(key);
      const { summary, points } = chartOf({
        from: plan.chart.from,
        to: plan.chart.to,
        step: plan.step,
        window: { since: plan.since, until: plan.until },
        spans,
        summarized: summarizedSpans(
          spans,
          input.boundaries.map(({ start, seconds }) => ({
            start,
            seconds: seconds.get(key)?.spans ?? [],
          })),
        ),
      });
      return { series, ...(now && { now }), summary, points };
    })
    .sort((a, b) => order(a.series).localeCompare(order(b.series)));
}

function selected(series: UsageSeries, filter: SeriesFilter): boolean {
  if (filter.kind === "host")
    return (
      series.scope === "host" ||
      series.scope === "rig" ||
      series.scope === "project"
    );
  return "projectId" in series && series.projectId === filter.projectId;
}

const TARGET_ORDER = { stable: "0", working: "1", preview: "2" } as const;

/** A sort key putting totals before parts and Targets in the order the pages show them. */
function order(series: UsageSeries): string {
  switch (series.scope) {
    case "host":
      return "0";
    case "rig":
      return "1";
    case "project":
      return `2 ${series.project}`;
    case "target":
      return `3 ${TARGET_ORDER[series.targetKind]} ${series.target}`;
    case "component":
      return `4 ${TARGET_ORDER[series.targetKind]} ${series.target} ${series.componentKind} ${series.component}`;
  }
}
