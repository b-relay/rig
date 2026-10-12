import type { MonitorResult } from "../../src/daemon/protocol";
import { USAGE_RANGES, type UsageRange } from "../../src/domain/usage-summary";
import { healthOf } from "./health";
import type { ActivityResult } from "./types";

type Operation = ActivityResult["operations"][number];

type ReportedSeries = MonitorResult["series"][number];
export type UsageSeriesId = ReportedSeries["series"];
type Stats = NonNullable<ReportedSeries["summary"]["cpu"]>;

/** One measure of one series, as a chart draws it: per point the average and the highest sample, `null` where nothing
 * was sampled; and over the whole range, the stats the chart labels. */
export interface ChartMeasure {
  readonly average: readonly (number | null)[];
  readonly high: readonly (number | null)[];
  readonly stats?: Stats;
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
  readonly range: MonitorResult["range"];
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

/** Pure: a `monitor` reply as the Monitor pages draw it. */
export function chartReport(report: MonitorResult): ChartReport {
  return {
    range: report.range,
    from: report.from,
    step: report.step,
    sampledEvery: report.sampledEvery,
    series: report.series.map((each) => ({
      key: seriesKeyOf(each.series),
      series: each.series,
      ...(each.now && { now: each.now }),
      cpu: {
        average: each.points.map((point) => point.cpu?.average ?? null),
        high: each.points.map((point) => point.cpu?.high ?? null),
        ...(each.summary.cpu && { stats: each.summary.cpu }),
      },
      memory: {
        average: each.points.map((point) => point.memory?.average ?? null),
        high: each.points.map((point) => point.memory?.high ?? null),
        ...(each.summary.memory && { stats: each.summary.memory }),
      },
    })),
  };
}

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
