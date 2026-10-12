import {
  mergeHistograms,
  quantileOf,
  type UsageHistogram,
} from "./usage-histogram";
import {
  cpuPercentOf,
  memoryBytesOf,
  type UsageHistograms,
} from "./usage-minute";

/** How one measure was spread over a span, in its natural unit: percent of a core for CPU, bytes for memory. */
export interface UsageStats {
  readonly low: number;
  readonly high: number;
  readonly average: number;
  readonly median: number;
  readonly p95: number;
}

/** CPU and memory over one span. Both are absent for a span with no samples: nothing ran then, or rigd was not sampling. */
export interface UsageSummary {
  readonly cpu?: UsageStats;
  readonly memory?: UsageStats;
}

/** One point of a chart: the span from `at` (Unix seconds) for one step. */
export interface UsagePoint extends UsageSummary {
  readonly at: number;
}

/** Histograms for one recorded span, a second or a minute, starting at `at` (Unix seconds). */
export interface RecordedSpan {
  readonly at: number;
  readonly histograms: UsageHistograms;
}

/** The span a usage report covers, in Unix seconds: from `since` up to `until`, or up to now when `until` is absent
 * (a live window). */
export interface UsageWindow {
  readonly since: number;
  readonly until?: number;
}

/** The dashboard's preset spans, each a live window ending now. */
export const USAGE_RANGES = ["1h", "24h", "7d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export const RANGE_SECONDS: Readonly<Record<UsageRange, number>> = {
  "1h": 3600,
  "24h": 86_400,
  "7d": 7 * 86_400,
};

/** The steps a chart may use, in seconds, so its points line up with whole minutes and hours. */
const STEPS = [
  1, 5, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400, 21_600,
  43_200, 86_400,
];
/** Roughly how many points a chart wants: enough to show a spike, few enough to draw every second. */
const POINTS_WANTED = 360;

/** Pure: the step for a chart of `rangeSeconds`: the smallest of the fixed steps that gives at most 360 points.
 * An hour gets 15 s points, a day 5 minutes, a week 30 minutes. */
export function stepFor(rangeSeconds: number): number {
  return (
    STEPS.find((step) => rangeSeconds / step <= POINTS_WANTED) ?? STEPS.at(-1)!
  );
}

/** Pure: a chart from `from` up to `to` (Unix seconds, `from` a multiple of `step`): one point per `step` from the
 * recorded spans that start in it, and the summary of the spans that start inside `window` (`since` up to `until`),
 * which whole steps may overhang. A step with no spans is a point with neither measure, which a chart draws as a gap;
 * spans outside the range are ignored. */
export function chartOf(input: {
  readonly from: number;
  readonly to: number;
  readonly step: number;
  readonly window: { readonly since: number; readonly until: number };
  readonly spans: Iterable<RecordedSpan>;
}): { readonly summary: UsageSummary; readonly points: UsagePoint[] } {
  const count = Math.max(0, Math.ceil((input.to - input.from) / input.step));
  const groups: UsageHistograms[][] = Array.from({ length: count }, () => []);
  const summarized: UsageHistograms[] = [];
  for (const span of input.spans) {
    const index = Math.floor((span.at - input.from) / input.step);
    if (span.at < input.to && index >= 0 && index < count)
      groups[index]!.push(span.histograms);
    if (span.at >= input.window.since && span.at < input.window.until)
      summarized.push(span.histograms);
  }
  const merged = groups.map(mergedHistograms);
  return {
    summary: summaryOf(summarized),
    points: merged.map((histograms, index) => ({
      at: input.from + index * input.step,
      ...(histograms ? summaryOf([histograms]) : {}),
    })),
  };
}

function mergedHistograms(
  histograms: readonly UsageHistograms[],
): UsageHistograms | undefined {
  const cpu = mergeHistograms(histograms.map((each) => each.cpu));
  const memory = mergeHistograms(histograms.map((each) => each.memory));
  return cpu && memory ? { cpu, memory } : undefined;
}

/** Pure: CPU and memory over all of the given histograms together. */
export function summaryOf(
  histograms: readonly UsageHistograms[],
): UsageSummary {
  const cpu = mergeHistograms(histograms.map((each) => each.cpu));
  const memory = mergeHistograms(histograms.map((each) => each.memory));
  return {
    ...(cpu && { cpu: statsOf(cpu, cpuPercentOf) }),
    ...(memory && { memory: statsOf(memory, memoryBytesOf) }),
  };
}

function statsOf(
  histogram: UsageHistogram,
  natural: (stored: number) => number,
): UsageStats {
  return {
    low: natural(histogram.low),
    high: natural(histogram.high),
    average: natural(histogram.sum / histogram.count),
    median: natural(quantileOf(histogram, 0.5)),
    p95: natural(quantileOf(histogram, 0.95)),
  };
}
