import { expect, test } from "bun:test";
import type { MonitorResult } from "../src/daemon/protocol";
import { markersOf, toneOfOutcome } from "../web/components/usage-cards";
import { rangeOf } from "../web/components/usage-range";
import { chartReport, peakOf, roundedTop, stacked } from "../web/lib/usage";

const stats = { low: 1, high: 9, average: 4, median: 3, p95: 8 };
const report: MonitorResult = {
  range: "1h",
  from: 1000,
  to: 1045,
  step: 15,
  sampledEvery: 1,
  series: [
    {
      series: { scope: "project", projectId: "p", project: "pantry" },
      now: { cpuPercent: 4, memoryBytes: 1e6 },
      summary: { cpu: stats, memory: stats },
      points: [
        { at: 1000, cpu: stats, memory: stats },
        { at: 1015 },
        { at: 1030, cpu: { ...stats, average: 6, high: 12 }, memory: stats },
      ],
    },
  ],
};

test("the browser gets each point's average and highest sample, null where nothing was sampled", () => {
  const charted = chartReport(report);
  expect(charted.series[0]!.key).toBe("project:p");
  expect(charted.series[0]!.cpu).toEqual({
    average: [4, null, 6],
    high: [9, null, 12],
    stats,
  });
});

test("stacked layers keep running totals, treat a silent layer as zero, and leave a gap only where every layer is silent", () => {
  expect(
    stacked([
      [1, null, 2, null],
      [3, 4, null, null],
    ]),
  ).toEqual([
    [1, 0, 2, null],
    [4, 4, 2, null],
  ]);
});

test("the peak is the point whose highest sample is greatest; a range with no samples has none", () => {
  expect(peakOf([null, 5, 12, 7])).toEqual({ index: 2, value: 12 });
  expect(peakOf([null, null])).toBeUndefined();
});

test("a chart's scale tops out at 1, 2 or 5 times a power of ten, never below its floor", () => {
  expect(roundedTop(437, 25)).toBe(500);
  expect(roundedTop(120, 25)).toBe(200);
  expect(roundedTop(0.4, 25)).toBe(50);
  expect(roundedTop(3e9, 64e6)).toBe(5e9);
});

test("Operations in a chart's range become markers toned like their dots; ones outside it, or with no tone, do not", () => {
  const at = (seconds: number) => new Date(seconds * 1000).toISOString();
  const operations = [
    {
      id: "1",
      action: "deploy",
      outcome: "deployed",
      occurredAt: at(1010),
      project: "pantry",
    },
    { id: "2", action: "up", outcome: "failed", occurredAt: at(1040) },
    { id: "3", action: "up", outcome: "failed", occurredAt: at(900) },
  ];
  expect(markersOf(operations, chartReport(report))).toEqual([
    { at: 1010, tone: "good", label: "deploy · pantry · deployed" },
    { at: 1040, tone: "bad", label: "up · failed" },
  ]);
  expect(toneOfOutcome("deployed")).toBe("good");
});

test("a range the page does not keep reads as the last hour", () => {
  expect(rangeOf("7d")).toBe("7d");
  expect(rangeOf("30d")).toBe("1h");
  expect(rangeOf(undefined)).toBe("1h");
});
