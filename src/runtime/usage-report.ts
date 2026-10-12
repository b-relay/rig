import { histogramsOf, type UsageHistograms } from "../domain/usage-minute";
import type { UsageSample } from "../domain/usage-sample";
import {
  pointsOf,
  RANGE_SECONDS,
  stepFor,
  summaryOf,
  type UsageRange,
  type UsagePoint,
  type UsageSummary,
} from "../domain/usage-summary";
import {
  seriesKey,
  type RecordedMinute,
  type SeriesFilter,
  type UsageHistory,
  type UsageSeries,
} from "./usage-history";
import type { UsageSnapshot } from "./usage-sampler";

/** One series of a usage report. */
export interface UsageReportSeries {
  readonly series: UsageSeries;
  /** The newest sample, when it is from the last couple of sampling intervals: absent once the series stops running. */
  readonly now?: UsageSample;
  /** CPU and memory over the whole range. */
  readonly summary: UsageSummary;
  readonly points: readonly UsagePoint[];
}

/** What a scope used over a range, for `rig monitor` and the dashboard's Monitor pages. */
export interface UsageReport {
  readonly range: UsageRange;
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
  /** What `filter` used over `range`, ending now. */
  report(request: {
    readonly filter: SeriesFilter;
    readonly range: UsageRange;
  }): Promise<UsageReport>;
  /** Removes all of a Project's history, buffered or stored, as `rig forget` does. */
  forget(projectId: string): Promise<void>;
}

/** The usage report for `filter` over `range`, ending at the current step. Stored history is merged with what the
 * sampler holds unwritten, so the chart reaches the current second; for a minute in both, the sampler's copy wins. Points
 * shorter than a minute are drawn from the 1-second detail; longer ones from per-minute histograms. Series are ordered
 * as the pages list them: the Host, Rig itself and Projects by name for the Host; the Project, then its Targets, then
 * their Components, for a Project. */
export async function usageReport(input: {
  readonly filter: SeriesFilter;
  readonly range: UsageRange;
  /** Milliseconds since the Unix epoch. */
  readonly now: number;
  readonly sampledEvery: number;
  readonly history: UsageHistory;
  readonly snapshot: UsageSnapshot;
}): Promise<UsageReport> {
  const step = stepFor(RANGE_SECONDS[input.range]);
  const nowSecond = Math.floor(input.now / 1000);
  const to = (Math.floor(nowSecond / step) + 1) * step;
  const from = to - Math.ceil(RANGE_SECONDS[input.range] / step) * step;
  const detail = step < 60;
  const stored = await input.history.read({
    filter: input.filter,
    from,
    to,
    detail,
  });

  const spans = new Map<
    string,
    { series: UsageSeries; byAt: Map<number, UsageHistograms> }
  >();
  const entry = (series: UsageSeries) => {
    const key = seriesKey(series);
    const found = spans.get(key) ?? { series, byAt: new Map() };
    found.series = series;
    spans.set(key, found);
    return found;
  };
  for (const history of stored) {
    const found = entry(history.series);
    for (const span of history.spans) found.byAt.set(span.at, span.histograms);
  }
  for (const minute of input.snapshot.pending) {
    if (!selected(minute.series, input.filter)) continue;
    const found = entry(minute.series);
    for (const span of spansOf(minute, detail))
      if (span.at >= from && span.at < to)
        found.byAt.set(span.at, span.histograms);
  }
  const fresh = new Map(
    input.snapshot.latest
      .filter(
        (latest) =>
          selected(latest.series, input.filter) &&
          latest.at >= nowSecond - 2 * input.sampledEvery,
      )
      .map((latest) => {
        entry(latest.series);
        return [seriesKey(latest.series), latest.sample] as const;
      }),
  );

  const series = [...spans.entries()]
    .map(([key, { series, byAt }]): UsageReportSeries => {
      const recorded = [...byAt].map(([at, histograms]) => ({
        at,
        histograms,
      }));
      const now = fresh.get(key);
      return {
        series,
        ...(now && { now }),
        summary: summaryOf(recorded.map((span) => span.histograms)),
        points: pointsOf({ from, to, step, spans: recorded }),
      };
    })
    .sort((a, b) => order(a.series).localeCompare(order(b.series)));
  return {
    range: input.range,
    from,
    to,
    step,
    sampledEvery: input.sampledEvery,
    series,
  };
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

/** A minute as spans: one per second for detail, or one for the whole minute. */
function spansOf(
  minute: RecordedMinute,
  detail: boolean,
): { at: number; histograms: UsageHistograms }[] {
  if (!detail) {
    const histograms = histogramsOf(minute.slots);
    return histograms ? [{ at: minute.minute * 60, histograms }] : [];
  }
  return minute.slots.flatMap((slot, second) => {
    const histograms = slot && histogramsOf([slot]);
    return histograms ? [{ at: minute.minute * 60 + second, histograms }] : [];
  });
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
