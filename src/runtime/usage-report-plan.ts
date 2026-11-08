import { stepFor } from "../domain/usage-summary";

/** Which stored spans a read takes: one per second of detail, or one per minute of history. */
export type SpanResolution = "second" | "minute";

/** The spans that start from `from` up to `to` (Unix seconds), at `resolution`. */
export interface SpanRange {
  readonly from: number;
  readonly to: number;
  readonly resolution: SpanResolution;
}

/** What a usage report reads and draws, in Unix seconds. */
export interface UsageReportPlan {
  /** The window's start. */
  readonly since: number;
  /** Where the summary stops, exclusive: the window's `until` when it has passed, else just after the current second. */
  readonly until: number;
  /** Seconds per point. */
  readonly step: number;
  /** The chart's spans: from the first point's start to the end of the last, at second resolution only when every
   * point is shorter than a minute and the window starts where 1-second detail is kept. */
  readonly chart: SpanRange;
  /** The starts of the minutes the window starts or ends inside, from where 1-second detail is kept: the summary reads
   * them second by second where a series still has their seconds. Empty when the chart is at second resolution. */
  readonly boundaries: readonly number[];
}

/** Pure: the plan for a report over the window from `since` up to `until`, absent for a live window, at `nowSecond`
 * (whole Unix seconds), when 1-second detail is kept from `detailSince`. A window starting after now is one empty
 * step, never inverted. */
export function usageReportPlan(input: {
  readonly since: number;
  readonly until: number | undefined;
  readonly nowSecond: number;
  readonly detailSince: number;
}): UsageReportPlan {
  const { since, nowSecond, detailSince } = input;
  const end = Math.max(Math.min(input.until ?? nowSecond, nowSecond), since);
  const wanted = stepFor(Math.max(end - since, 1));
  const resolution = wanted < 60 && since >= detailSince ? "second" : "minute";
  const step = resolution === "second" ? wanted : Math.max(wanted, 60);
  // A window ending now counts the second being sampled.
  const until =
    input.until !== undefined && input.until <= nowSecond
      ? input.until
      : nowSecond + 1;
  const boundaries =
    resolution === "second"
      ? []
      : [
          ...new Set(
            [since, ...(until <= nowSecond ? [until] : [])]
              .filter((at) => at % 60 !== 0 && at >= detailSince)
              .map((at) => Math.floor(at / 60) * 60),
          ),
        ];
  return {
    since,
    until,
    step,
    chart: {
      from: Math.floor(since / step) * step,
      to: (Math.floor(end / step) + 1) * step,
      resolution,
    },
    boundaries,
  };
}
