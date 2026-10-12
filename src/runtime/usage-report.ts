import { mergeHistograms } from "../domain/usage-histogram";
import {
  histogramsOf,
  SLOTS_PER_MINUTE,
  type UsageHistograms,
} from "../domain/usage-minute";
import type { UsageSample } from "../domain/usage-sample";
import {
  chartOf,
  RANGE_SECONDS,
  stepFor,
  type RecordedSpan,
  type UsagePoint,
  type UsageRange,
  type UsageSummary,
} from "../domain/usage-summary";
import {
  seriesKey,
  type RecordedMinute,
  type SeriesFilter,
  type SeriesHistory,
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

/** The usage report for `filter` over `range`, ending at the current step. Stored history is overlaid with the minutes
 * the sampler holds unwritten, so the chart reaches the current second: second by second, a held sample replaces the
 * stored one, and stored seconds the sampler does not hold (written before a rigd restart) are kept. Points shorter
 * than a minute are drawn from the 1-second detail; longer ones from per-minute histograms. Series are ordered as the
 * pages list them: the Host, Rig itself and Projects by name for the Host; the Project, then its Targets, then their
 * Components, for a Project. */
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
  const pending = input.snapshot.pending.filter(
    (minute) =>
      selected(minute.series, input.filter) &&
      (minute.minute + 1) * 60 > from &&
      minute.minute * 60 < to,
  );
  const stored = await input.history.read({
    filter: input.filter,
    from,
    to,
    detail,
  });
  // A held minute replaces its stored minute, so the stored seconds of the held minutes are read to merge into them.
  const storedSeconds =
    detail || pending.length === 0
      ? stored
      : await input.history.read({
          filter: input.filter,
          from: Math.min(...pending.map((minute) => minute.minute)) * 60,
          to: (Math.max(...pending.map((minute) => minute.minute)) + 1) * 60,
          detail: true,
        });
  const overlays = overlaysOf(pending, detail ? [] : storedSeconds, detail);

  const entries = new Map<
    string,
    { series: UsageSeries; stored: SeriesHistory["spans"] }
  >();
  const entry = (series: UsageSeries) => {
    const key = seriesKey(series);
    const found = entries.get(key) ?? { series, stored: [] };
    found.series = series;
    entries.set(key, found);
    return found;
  };
  for (const history of stored) entry(history.series).stored = history.spans;
  for (const { series } of overlays.values()) entry(series);
  const fresh = new Map<string, UsageSample>();
  for (const latest of input.snapshot.latest)
    if (
      selected(latest.series, input.filter) &&
      latest.at >= nowSecond - 2 * input.sampledEvery
    ) {
      entry(latest.series);
      fresh.set(seriesKey(latest.series), latest.sample);
    }

  const series = [...entries.entries()]
    .map(([key, { series, stored }]): UsageReportSeries => {
      const overlay = overlays.get(key)?.spans;
      const spans: RecordedSpan[] = overlay
        ? [
            ...stored.filter((span) => !overlay.has(span.at)),
            ...[...overlay].map(([at, histograms]) => ({ at, histograms })),
          ]
        : [...stored];
      const now = fresh.get(key);
      const { summary, points } = chartOf({ from, to, step, spans });
      return { series, ...(now && { now }), summary, points };
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

/** Each series' held spans, by start: one per held second for detail; otherwise one per held minute, built from its
 * held seconds and, for the seconds it does not hold, the stored ones. */
function overlaysOf(
  pending: readonly RecordedMinute[],
  storedSeconds: readonly SeriesHistory[],
  detail: boolean,
): Map<string, { series: UsageSeries; spans: Map<number, UsageHistograms> }> {
  const storedByKey = new Map(
    storedSeconds.map((history) => [
      seriesKey(history.series),
      new Map(history.spans.map((span) => [span.at, span.histograms])),
    ]),
  );
  const overlays = new Map<
    string,
    { series: UsageSeries; spans: Map<number, UsageHistograms> }
  >();
  for (const minute of pending) {
    const key = seriesKey(minute.series);
    const found = overlays.get(key) ?? {
      series: minute.series,
      spans: new Map<number, UsageHistograms>(),
    };
    overlays.set(key, found);
    const start = minute.minute * 60;
    const seconds: UsageHistograms[] = [];
    for (let second = 0; second < SLOTS_PER_MINUTE; second++) {
      const held = minute.slots[second];
      const histograms = held
        ? histogramsOf([held])
        : storedByKey.get(key)?.get(start + second);
      if (!histograms) continue;
      if (detail) found.spans.set(start + second, histograms);
      else seconds.push(histograms);
    }
    if (detail || seconds.length === 0) continue;
    found.spans.set(start, {
      cpu: mergeHistograms(seconds.map((each) => each.cpu))!,
      memory: mergeHistograms(seconds.map((each) => each.memory))!,
    });
  }
  return overlays;
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
