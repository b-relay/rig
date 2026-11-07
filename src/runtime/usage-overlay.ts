import { mergeHistograms } from "../domain/usage-histogram";
import {
  histogramsOf,
  SLOTS_PER_MINUTE,
  type UsageHistograms,
} from "../domain/usage-minute";
import type { RecordedSpan } from "../domain/usage-summary";
import {
  seriesKey,
  type RecordedMinute,
  type SeriesHistory,
  type UsageSeries,
} from "./usage-history";
import type { SpanRange } from "./usage-report-plan";

/** One series' spans as a report draws them. */
export interface SeriesSpans {
  readonly series: UsageSeries;
  readonly spans: readonly RecordedSpan[];
}

/** Pure: the held minutes with a second from `from` up to `to` (Unix seconds). */
export function heldIn(
  pending: readonly RecordedMinute[],
  range: Pick<SpanRange, "from" | "to">,
): RecordedMinute[] {
  return pending.filter(
    (minute) =>
      (minute.minute + 1) * 60 > range.from && minute.minute * 60 < range.to,
  );
}

/** Pure: a held minute's seconds, one span per Unix second: each second it holds, and for each second it does not, the
 * stored one in `stored` (by Unix second), if any. */
export function secondsOf(
  minute: RecordedMinute,
  stored?: ReadonlyMap<number, UsageHistograms>,
): RecordedSpan[] {
  const start = minute.minute * 60;
  const seconds: RecordedSpan[] = [];
  for (let second = 0; second < SLOTS_PER_MINUTE; second++) {
    const held = minute.slots[second];
    const histograms = held
      ? histogramsOf([held])
      : stored?.get(start + second);
    if (histograms) seconds.push({ at: start + second, histograms });
  }
  return seconds;
}

/** Pure: each series' stored spans (`stored`, at `resolution`) with the held minutes laid over them, keyed by
 * `seriesKey`. At second resolution each held second replaces the stored one, and stored seconds a held minute does
 * not hold stay. At minute resolution a held minute replaces its stored minute with one span merging its seconds
 * (`secondsOf`, with `storedSeconds`, the stored seconds of the held minutes), and leaves it when it has none. Where
 * held minutes repeat a series' minute, the last one's spans win. A series only held is added after the stored ones,
 * under the names its first held minute has. */
export function overlaid(
  input:
    | {
        readonly resolution: "second";
        readonly stored: readonly SeriesHistory[];
        readonly held: readonly RecordedMinute[];
      }
    | {
        readonly resolution: "minute";
        readonly stored: readonly SeriesHistory[];
        readonly storedSeconds: readonly SeriesHistory[];
        readonly held: readonly RecordedMinute[];
      },
): Map<string, SeriesSpans> {
  const storedSeconds = new Map(
    (input.resolution === "minute" ? input.storedSeconds : []).map(
      (history) => [
        seriesKey(history.series),
        new Map(history.spans.map((span) => [span.at, span.histograms])),
      ],
    ),
  );
  const overlays = new Map<
    string,
    { series: UsageSeries; spans: Map<number, UsageHistograms> }
  >();
  for (const minute of input.held) {
    const key = seriesKey(minute.series);
    const found = overlays.get(key) ?? {
      series: minute.series,
      spans: new Map<number, UsageHistograms>(),
    };
    overlays.set(key, found);
    const spans =
      input.resolution === "second"
        ? secondsOf(minute)
        : minuteOf(
            minute.minute * 60,
            secondsOf(minute, storedSeconds.get(key)),
          );
    for (const span of spans) found.spans.set(span.at, span.histograms);
  }
  const entries = new Map<string, SeriesSpans>(
    input.stored.map((history) => [
      seriesKey(history.series),
      { series: history.series, spans: [...history.spans] },
    ]),
  );
  for (const [key, overlay] of overlays)
    entries.set(key, {
      series: overlay.series,
      spans: [
        ...(entries.get(key)?.spans ?? []).filter(
          (span) => !overlay.spans.has(span.at),
        ),
        ...[...overlay.spans].map(([at, histograms]) => ({ at, histograms })),
      ],
    });
  return entries;
}

/** Pure: the spans a summary counts for one series: its spans, with each boundary minute (`start`, Unix seconds) it
 * has seconds for replaced by them. A boundary minute whose seconds are pruned counts whole from its start. */
export function summarizedSpans(
  spans: readonly RecordedSpan[],
  boundaries: readonly {
    readonly start: number;
    readonly seconds: readonly RecordedSpan[];
  }[],
): readonly RecordedSpan[] {
  const finer = boundaries.filter(({ seconds }) => seconds.length > 0);
  if (finer.length === 0) return spans;
  return [
    ...spans.filter((each) => !finer.some(({ start }) => start === each.at)),
    ...finer.flatMap(({ seconds }) => seconds),
  ];
}

function minuteOf(start: number, seconds: readonly RecordedSpan[]) {
  if (seconds.length === 0) return [];
  return [
    {
      at: start,
      histograms: {
        cpu: mergeHistograms(seconds.map((each) => each.histograms.cpu))!,
        memory: mergeHistograms(seconds.map((each) => each.histograms.memory))!,
      },
    },
  ];
}
