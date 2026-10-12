import type { MonitorResult } from "../../src/daemon/protocol";
import {
  RANGE_SECONDS,
  USAGE_RANGES,
  type UsageRange,
} from "../../src/domain/usage-summary";
import type { Peak } from "./chart-layout";
import { healthOf } from "./health";
import type { ActivityResult } from "./types";

type Operation = ActivityResult["operations"][number];

type ReportedSeries = MonitorResult["series"][number];
export type UsageSeriesId = ReportedSeries["series"];

/** One measure of one series, as a chart draws it: per point the average, `null` where nothing was sampled; and over
 * the whole range, where the highest sample fell and the median. Both are absent when nothing was sampled. */
export interface ChartMeasure {
  readonly average: readonly (number | null)[];
  readonly peak?: Peak;
  readonly median?: number;
}

/** One series of a Monitor page: what it is, its newest sample, and both measures. */
export interface ChartSeries {
  readonly key: string;
  readonly series: UsageSeriesId;
  readonly now?: { readonly cpuPercent: number; readonly memoryBytes: number };
  readonly cpu: ChartMeasure;
  readonly memory: ChartMeasure;
}

/** What the Monitor pages draw: a `monitor` reply cut to the numbers the charts use, small enough to poll every sample. */
export interface ChartReport {
  /** The preset the chart shows: the last hour, day or week. */
  readonly range: UsageRange;
  /** Unix seconds of the first point, and seconds per point. */
  readonly from: number;
  readonly step: number;
  readonly sampledEvery: number;
  readonly series: readonly ChartSeries[];
}

/** Pure: the identity of a series, the same across polls, for keys and colours. */
export function seriesKeyOf(series: UsageSeriesId): string {
  return [
    series.scope,
    series.projectId,
    series.targetId,
    series.componentKind,
    series.component,
  ]
    .filter(Boolean)
    .join(":");
}

/** Pure: the window a preset reads, ending now (`now` in milliseconds). */
export function presetWindow(
  range: UsageRange,
  now: number,
): { readonly since: string } {
  return { since: new Date(now - RANGE_SECONDS[range] * 1000).toISOString() };
}

/** Pure: a `monitor` reply as the Monitor pages draw it, for the preset it was read for. With `target`, a Project's
 * Components are kept only for that Target (none for `all`), since the page charts no others. */
export function chartReport(
  report: MonitorResult,
  range: UsageRange,
  target?: string,
): ChartReport {
  return componentsOf(wholeChartReport(report, range), target);
}

/** Pure: a chart report with a Project's Components kept only for `target` (none for `all`); every series with no
 * `target`. */
export function componentsOf(
  report: ChartReport,
  target: string | undefined,
): ChartReport {
  return target === undefined
    ? report
    : {
        ...report,
        series: report.series.filter(
          (each) =>
            each.series.scope !== "component" || each.series.target === target,
        ),
      };
}

function wholeChartReport(
  report: MonitorResult,
  range: UsageRange,
): ChartReport {
  const measure = (
    each: ReportedSeries,
    of: "cpu" | "memory",
  ): ChartMeasure => {
    const peak = peakOf(each.points.map((point) => point[of]?.high ?? null));
    const median = each.summary[of]?.median;
    return {
      average: each.points.map((point) => point[of]?.average ?? null),
      ...(peak && { peak }),
      ...(median !== undefined && { median }),
    };
  };
  return {
    range,
    from: report.from,
    step: report.step,
    sampledEvery: report.sampledEvery,
    series: report.series.map((each) => ({
      key: seriesKeyOf(each.series),
      series: each.series,
      ...(each.now && { now: each.now }),
      cpu: measure(each, "cpu"),
      memory: measure(each, "memory"),
    })),
  };
}

export type { UsageRange };
export { formatBytes as bytes } from "../../src/domain/bytes";
export { formatCpu as percent } from "../../src/domain/usage-sample";

/** Pure: a round top for a chart's scale, at or above `value`: 1, 2 or 5 times a power of ten (a busy Host's CPU reads
 * up to 500%, not 437%). Never below `floor`, so an idle chart still has a scale. */
export function roundedTop(value: number, floor: number): number {
  const top = Math.max(value, floor);
  const power = 10 ** Math.floor(Math.log10(top));
  return ([1, 2, 5, 10].find((step) => step * power >= top) ?? 10) * power;
}

/** Pure: the running totals of stacked series, point by point: the first series, then the first two, and so on. A
 * point no series sampled is `null` in every layer, so a stack has gaps where nothing ran. */
export function stacked(
  layers: readonly (readonly (number | null)[])[],
): (number | null)[][] {
  const totals: (number | null)[][] = [];
  layers.forEach((layer, index) => {
    totals.push(
      layer.map((value, point) => {
        const below = index === 0 ? null : totals[index - 1]![point]!;
        if (value === null && below === null)
          return layers.some((other) => other[point] !== null) ? 0 : null;
        return (below ?? 0) + (value ?? 0);
      }),
    );
  });
  return totals;
}

/** Pure: where the highest sample of a range fell: the point whose highest sample is greatest, and that sample. */
export function peakOf(
  high: readonly (number | null)[],
): { readonly index: number; readonly value: number } | undefined {
  let found: { index: number; value: number } | undefined;
  high.forEach((value, index) => {
    if (value !== null && (found === undefined || value > found.value))
      found = { index, value };
  });
  return found;
}

/** Pure: the label of a point's time, as the chart's axis and tooltip show it: the time of day for a day or less,
 * the weekday and time for a week. */
export function timeLabel(
  at: number,
  range: ChartReport["range"],
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat("en-GB", {
    ...(range === "7d" ? { weekday: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(at * 1000));
}

/** Pure: the range a page's `?range=` asks for, or 1h when it names none Rig keeps. */
export function rangeOf(value: string | undefined): UsageRange {
  return (USAGE_RANGES as readonly string[]).includes(value ?? "")
    ? (value as UsageRange)
    : "1h";
}

/** Something that happened, marked on a chart's time axis. */
export interface ChartMarker {
  /** Unix seconds. */
  readonly at: number;
  readonly tone: "good" | "warn" | "bad";
  readonly label: string;
}

/** Pure: how an Operation's outcome reads as a marker, as its dot reads everywhere else: `undefined` for an outcome
 * with no tone, which gets no marker. */
export function toneOfOutcome(
  outcome: string,
): ChartMarker["tone"] | undefined {
  const health = healthOf(outcome);
  return health === "green"
    ? "good"
    : health === "red"
      ? "bad"
      : health === "orange"
        ? "warn"
        : undefined;
}

/** Pure: the Operations that fall in a report's range, as markers on its time axis. */
export function markersOf(
  operations: readonly Operation[],
  report: Pick<ChartReport, "from" | "step" | "series">,
): ChartMarker[] {
  const count = report.series[0]?.cpu.average.length ?? 0;
  const end = report.from + count * report.step;
  return operations.flatMap((operation) => {
    const at = Date.parse(operation.occurredAt) / 1000;
    const tone = toneOfOutcome(operation.outcome);
    if (!(at >= report.from && at < end) || !tone) return [];
    return [
      {
        at,
        tone,
        label: [
          operation.action,
          operation.project,
          operation.target,
          operation.outcome,
        ]
          .filter(Boolean)
          .join(" · "),
      },
    ];
  });
}

/** One card of a Monitor page: a Project, Target, Service or Job, with its series once something of it was sampled. */
export interface UsageCard {
  readonly key: string;
  readonly name: string;
  /** `service` or `job`, on a Component's card. */
  readonly kind?: string;
  readonly series?: ChartSeries;
  /** Which incarnation of its name this card shows when the name was sampled under several identities, such as a
   * Preview destroyed and created again: `earlier` beside the current one, or `2 of 3` when none can be told current. */
  readonly incarnation?: string;
}

/** Pure: of the series sampled under one name, the current one: the one running now; else the one sampled latest.
 * `undefined` when none was sampled, or when several tie and none can be told current. Every Monitor view picks the
 * current incarnation this way. */
export function currentOf(
  group: readonly ChartSeries[],
): ChartSeries | undefined {
  const live = group.filter((each) => each.now);
  const pool = live.length > 0 ? live : group;
  const lastSampled = (each: ChartSeries) =>
    Math.max(
      each.cpu.average.findLastIndex((value) => value !== null),
      each.memory.average.findLastIndex((value) => value !== null),
    );
  const latest = Math.max(...pool.map(lastSampled));
  const newest = pool.filter((each) => lastSampled(each) === latest);
  return newest.length === 1 ? newest[0] : undefined;
}

/** Pure: a card per thing the inventory names, in its order, then one per name sampled that it no longer names (a
 * destroyed Preview still in the range). A name sampled under several identities keeps them all: the current one on
 * the name's card and each other on its own card marked `earlier`; when none is current, each on its own card marked
 * `1 of 2` and so on. `identify` names a series as the inventory does. */
export function cardsOf(
  inventory: readonly { readonly name: string; readonly kind?: string }[],
  sampled: readonly ChartSeries[],
  identify: (series: ChartSeries) => { name: string; kind?: string },
): UsageCard[] {
  const idOf = (each: { name: string; kind?: string }) =>
    `${each.kind ?? ""}:${each.name}`;
  const groups = new Map<
    string,
    { name: string; kind?: string; series: ChartSeries[] }
  >();
  for (const each of inventory) groups.set(idOf(each), { ...each, series: [] });
  for (const each of sampled) {
    const named = identify(each);
    const id = idOf(named);
    const group = groups.get(id) ?? { ...named, series: [] };
    group.series.push(each);
    groups.set(id, group);
  }
  return [...groups.entries()].flatMap(([id, group]): UsageCard[] => {
    const base = { name: group.name, ...(group.kind && { kind: group.kind }) };
    const current = currentOf(group.series);
    if (group.series.length > 1 && !current)
      return group.series.map((series, index) => ({
        ...base,
        key: series.key,
        series,
        incarnation: `${index + 1} of ${group.series.length}`,
      }));
    return [
      { ...base, key: id, ...(current && { series: current }) },
      ...group.series
        .filter((series) => series !== current)
        .map((series) => ({
          ...base,
          key: series.key,
          series,
          incarnation: "earlier",
        })),
    ];
  });
}
