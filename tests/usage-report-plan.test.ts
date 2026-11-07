import { describe, expect, test } from "bun:test";
import { usageReportPlan } from "../src/runtime/usage-report-plan";

// Unix seconds: half a minute into minute 6000.
const NOW = 6000 * 60 + 30;
const HOUR = 3600;
const DAY = 86_400;

describe("usage report plans", () => {
  test("a live hour inside the detail is drawn second by second and counts the second being sampled", () => {
    expect(
      usageReportPlan({
        since: NOW - HOUR,
        until: undefined,
        nowSecond: NOW,
        detailSince: 0,
      }),
    ).toEqual({
      since: NOW - HOUR,
      until: NOW + 1,
      step: 15,
      chart: { from: NOW - HOUR, to: NOW + 15, resolution: "second" },
      boundaries: [],
    });
  });

  test("a window starting where detail is kept from is still second by second; a second earlier reads minutes", () => {
    const since = NOW - HOUR;
    expect(
      usageReportPlan({
        since,
        until: undefined,
        nowSecond: NOW,
        detailSince: since,
      }).chart.resolution,
    ).toBe("second");
    const pruned = usageReportPlan({
      since,
      until: undefined,
      nowSecond: NOW,
      detailSince: since + 1,
    });
    // Minute steps from the whole minute, and the start's minute is not read by the second: its seconds are gone.
    expect(pruned).toEqual({
      since,
      until: NOW + 1,
      step: 60,
      chart: { from: since - 30, to: NOW + 30, resolution: "minute" },
      boundaries: [],
    });
  });

  test("a day reads minutes, and the minute a live window starts inside second by second", () => {
    expect(
      usageReportPlan({
        since: NOW - DAY,
        until: undefined,
        nowSecond: NOW,
        detailSince: 0,
      }),
    ).toEqual({
      since: NOW - DAY,
      until: NOW + 1,
      step: 300,
      chart: { from: NOW - DAY - 30, to: NOW + 270, resolution: "minute" },
      boundaries: [NOW - DAY - 30],
    });
  });

  test("a closed window ends where it says, exclusive, and reads both minutes it starts and ends inside", () => {
    const until = NOW - HOUR + 10;
    expect(
      usageReportPlan({
        since: NOW - DAY,
        until,
        nowSecond: NOW,
        detailSince: 0,
      }),
    ).toEqual({
      since: NOW - DAY,
      until,
      step: 300,
      chart: {
        from: NOW - DAY - 30,
        to: NOW - HOUR + 270,
        resolution: "minute",
      },
      boundaries: [NOW - DAY - 30, until - 40],
    });
  });

  test("a window starting or ending on a whole minute has no boundary minute there", () => {
    expect(
      usageReportPlan({
        since: NOW - DAY - 30,
        until: NOW - HOUR - 30,
        nowSecond: NOW,
        detailSince: 0,
      }).boundaries,
    ).toEqual([]);
  });

  test("a window ending now excludes the current second, and one ending later counts it and has no end boundary", () => {
    const endingNow = usageReportPlan({
      since: NOW - DAY,
      until: NOW,
      nowSecond: NOW,
      detailSince: 0,
    });
    expect(endingNow.until).toBe(NOW);
    expect(endingNow.boundaries).toEqual([NOW - DAY - 30, NOW - 30]);
    const endingLater = usageReportPlan({
      since: NOW - DAY,
      until: NOW + 100,
      nowSecond: NOW,
      detailSince: 0,
    });
    expect(endingLater.until).toBe(NOW + 1);
    expect(endingLater.chart.to).toBe(NOW + 270);
    expect(endingLater.boundaries).toEqual([NOW - DAY - 30]);
  });

  test("only the boundary minutes from where detail is kept are read second by second", () => {
    const until = NOW - HOUR + 10;
    expect(
      usageReportPlan({
        since: NOW - DAY,
        until,
        nowSecond: NOW,
        detailSince: NOW - 2 * HOUR,
      }).boundaries,
    ).toEqual([until - 40]);
    expect(
      usageReportPlan({
        since: NOW - DAY,
        until,
        nowSecond: NOW,
        detailSince: until + 1,
      }).boundaries,
    ).toEqual([]);
  });

  test("a window wholly in the future, or ending before it starts, is one empty step", () => {
    expect(
      usageReportPlan({
        since: NOW + 100,
        until: undefined,
        nowSecond: NOW,
        detailSince: 0,
      }),
    ).toEqual({
      since: NOW + 100,
      until: NOW + 1,
      step: 1,
      chart: { from: NOW + 100, to: NOW + 101, resolution: "second" },
      boundaries: [],
    });
    expect(
      usageReportPlan({
        since: NOW - HOUR,
        until: NOW - 2 * HOUR,
        nowSecond: NOW,
        detailSince: 0,
      }),
    ).toEqual({
      since: NOW - HOUR,
      until: NOW - 2 * HOUR,
      step: 1,
      chart: { from: NOW - HOUR, to: NOW - HOUR + 1, resolution: "second" },
      boundaries: [],
    });
  });

  test("a window between whole seconds starts its chart at the step it falls in", () => {
    const plan = usageReportPlan({
      since: NOW - HOUR + 0.5,
      until: NOW - 0.25,
      nowSecond: NOW,
      detailSince: 0,
    });
    expect(plan.chart).toEqual({
      from: NOW - HOUR,
      to: NOW,
      resolution: "second",
    });
    expect(plan.until).toBe(NOW - 0.25);
  });
});
