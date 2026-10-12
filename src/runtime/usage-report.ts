import { mergeHistograms } from "../domain/usage-histogram";
import {
  histogramsOf,
  SLOTS_PER_MINUTE,
  type UsageHistograms,
} from "../domain/usage-minute";
import type { UsageSample } from "../domain/usage-sample";
import {
  chartOf,
  stepFor,
  type RecordedSpan,
  type UsagePoint,
  type UsageSummary,
  type UsageWindow,
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

/** The usage report for `filter` over `window`, in steps sized to the window (about 360 points). Stored history is
 * overlaid with the minutes the sampler holds unwritten, so the chart reaches the current second: second by second, a
 * held sample replaces the stored one, and stored seconds the sampler does not hold (written before a rigd restart)
 * are kept. Points shorter than a minute are drawn from the 1-second detail when the window starts after
 * `detailSince`; otherwise, and for longer steps, from per-minute histograms. The summary counts only samples inside
 * the window: a minute it starts or ends inside is read second by second while its detail is kept, and counted whole
 * from its start once only the minute is. A window wholly in the future is one empty step. Series are ordered as the
 * pages list them: the Host, Rig itself and Projects by name for the Host; the Project, then its Targets, then their
 * Components, for a Project. */
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
  const { since } = input.window;
  // Detail retention may have grown since the last prune; the seconds before the oldest one kept are gone all the same.
  const detailSince = Math.max(
    input.detailSince,
    await input.history.detailFrom(),
  );
  // A window starting after now is empty but never inverted.
  const end = Math.max(
    Math.min(input.window.until ?? nowSecond, nowSecond),
    since,
  );
  const span = Math.max(end - since, 1);
  const detail = stepFor(span) < 60 && since >= detailSince;
  const step = detail ? stepFor(span) : Math.max(stepFor(span), 60);
  const from = Math.floor(since / step) * step;
  const to = (Math.floor(end / step) + 1) * step;
  // `until` is exclusive; a window ending now counts the second being sampled.
  const until =
    input.window.until !== undefined && input.window.until <= nowSecond
      ? input.window.until
      : nowSecond + 1;
  const read = (range: { from: number; to: number; detail: boolean }) =>
    spansIn({
      ...range,
      filter: input.filter,
      history: input.history,
      pending: input.snapshot.pending,
    });
  const entries = await read({ from, to, detail });

  // The minutes the window starts or ends inside: the summary reads them second by second where their seconds are kept.
  const boundaries = detail
    ? []
    : [
        ...new Set(
          [since, ...(until <= nowSecond ? [until] : [])]
            .filter((at) => at % 60 !== 0 && at >= detailSince)
            .map((at) => Math.floor(at / 60) * 60),
        ),
      ];
  const boundarySeconds = await Promise.all(
    boundaries.map((start) =>
      read({ from: start, to: start + 60, detail: true }),
    ),
  );

  const fresh = new Map<string, UsageSample>();
  for (const latest of input.snapshot.latest)
    if (
      selected(latest.series, input.filter) &&
      latest.at >= nowSecond - 2 * input.sampledEvery
    ) {
      if (!entries.has(seriesKey(latest.series)))
        entries.set(seriesKey(latest.series), {
          series: latest.series,
          spans: [],
        });
      fresh.set(seriesKey(latest.series), latest.sample);
    }

  const series = [...entries.entries()]
    .map(([key, { series, spans }]): UsageReportSeries => {
      const now = fresh.get(key);
      // A boundary minute is replaced by its seconds only where this series has them; once they are pruned (whatever
      // detail retention says now) the whole minute counts from its start.
      const finer = boundaries.flatMap((start, index) => {
        const seconds = boundarySeconds[index]!.get(key)?.spans ?? [];
        return seconds.length ? [{ start, seconds }] : [];
      });
      const summarized = finer.length
        ? [
            ...spans.filter(
              (each) => !finer.some(({ start }) => start === each.at),
            ),
            ...finer.flatMap(({ seconds }) => seconds),
          ]
        : spans;
      const { summary, points } = chartOf({
        from,
        to,
        step,
        window: { since, until },
        spans,
        summarized,
      });
      return { series, ...(now && { now }), summary, points };
    })
    .sort((a, b) => order(a.series).localeCompare(order(b.series)));
  return {
    since,
    ...(input.window.until !== undefined && { until: input.window.until }),
    from,
    to,
    step,
    sampledEvery: input.sampledEvery,
    series,
  };
}

/** Each selected series' spans from `from` up to `to`: one per second for `detail`, else one per minute; stored history
 * overlaid with the minutes the sampler holds unwritten. */
async function spansIn(input: {
  readonly filter: SeriesFilter;
  readonly from: number;
  readonly to: number;
  readonly detail: boolean;
  readonly history: UsageHistory;
  readonly pending: readonly RecordedMinute[];
}): Promise<Map<string, { series: UsageSeries; spans: RecordedSpan[] }>> {
  const { filter, from, to, detail } = input;
  const pending = input.pending.filter(
    (minute) =>
      selected(minute.series, filter) &&
      (minute.minute + 1) * 60 > from &&
      minute.minute * 60 < to,
  );
  const stored = await input.history.read({ filter, from, to, detail });
  // A held minute replaces its stored minute, so the stored seconds of the held minutes are read to merge into them.
  const storedSeconds =
    detail || pending.length === 0
      ? stored
      : await input.history.read({
          filter,
          from: Math.min(...pending.map((minute) => minute.minute)) * 60,
          to: (Math.max(...pending.map((minute) => minute.minute)) + 1) * 60,
          detail: true,
        });
  const overlays = overlaysOf(pending, detail ? [] : storedSeconds, detail);
  const entries = new Map<
    string,
    { series: UsageSeries; spans: RecordedSpan[] }
  >();
  for (const history of stored)
    entries.set(seriesKey(history.series), {
      series: history.series,
      spans: [...history.spans],
    });
  for (const [key, overlay] of overlays) {
    const found = entries.get(key);
    entries.set(key, {
      series: overlay.series,
      spans: [
        ...(found?.spans ?? []).filter((span) => !overlay.spans.has(span.at)),
        ...[...overlay.spans].map(([at, histograms]) => ({ at, histograms })),
      ],
    });
  }
  return entries;
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
