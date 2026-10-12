import { expect, test } from "bun:test";
import type { MonitorResult } from "../src/daemon/protocol";
import { chartLayout } from "../web/lib/chart-layout";
import {
  cardsOf,
  chartReport,
  markersOf,
  peakOf,
  presetWindow,
  rangeOf,
  roundedTop,
  stacked,
  toneOfOutcome,
} from "../web/lib/usage";

const stats = { low: 1, high: 9, average: 4, median: 3, p95: 8 };
const report: MonitorResult = {
  since: 1000,
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

test("the browser gets each point's average, null where nothing was sampled, where the peak fell and the median", () => {
  const charted = chartReport(report, "1h");
  expect(charted.series[0]!.key).toBe("project:p");
  expect(charted.series[0]!.cpu).toEqual({
    average: [4, null, 6],
    peak: { index: 2, value: 12 },
    median: 3,
  });
});

test("a Project's report keeps only the chosen Target's Components, and none for all", () => {
  const component = (target: string) => ({
    series: {
      scope: "component" as const,
      projectId: "p",
      project: "pantry",
      targetId: target,
      target,
      targetKind: "stable" as const,
      component: "web",
      componentKind: "service" as const,
    },
    summary: {},
    points: [],
  });
  const both = {
    ...report,
    series: [...report.series, component("stable"), component("working")],
  };
  const scopes = (target?: string) =>
    chartReport(both, "1h", target).series.map(
      (each) => `${each.series.scope}:${each.series.target ?? ""}`,
    );
  expect(scopes("stable")).toEqual(["project:", "component:stable"]);
  expect(scopes("all")).toEqual(["project:"]);
  expect(scopes()).toHaveLength(3);
});

test("cards follow the inventory, with an empty card for what was never sampled and one for what it no longer names", () => {
  const sampled = chartReport(report, "1h").series;
  const cards = cardsOf(
    [{ name: "pantry" }, { name: "fletcher" }],
    [
      ...sampled,
      { ...sampled[0]!, series: { ...sampled[0]!.series, project: "gone" } },
    ],
    (each) => ({ name: each.series.project! }),
  );
  expect(cards.map((card) => [card.name, card.series !== undefined])).toEqual([
    ["pantry", true],
    ["fletcher", false],
    ["gone", true],
  ]);
  // A Preview destroyed and created again: both incarnations keep their charts, the newest on the named card.
  const preview = (targetId: string, sampledLast: boolean) => ({
    ...sampled[0]!,
    key: `target:p:${targetId}`,
    series: {
      ...sampled[0]!.series,
      scope: "target" as const,
      targetId,
      target: "feature",
    },
    cpu: {
      average: sampledLast ? [null, null, 5] : [4, null, null],
    },
  });
  const incarnations = cardsOf(
    [{ name: "feature" }],
    [preview("new", true), preview("old", false)],
    (each) => ({ name: each.series.target! }),
  );
  expect(
    incarnations.map((card) => [card.key, card.series?.key, !!card.earlier]),
  ).toEqual([
    [":feature", "target:p:new", false],
    ["target:p:old", "target:p:old", true],
  ]);
  // A Service and a Job of the same name are different cards.
  expect(
    cardsOf(
      [
        { name: "web", kind: "service" },
        { name: "web", kind: "job" },
      ],
      [],
      () => ({ name: "" }),
    ).map((card) => card.key),
  ).toEqual(["service:web", "job:web"]);
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
    { id: "4", action: "down", outcome: "stopped", occurredAt: at(1020) },
  ];
  expect(markersOf(operations, chartReport(report, "1h"))).toEqual([
    { at: 1010, tone: "good", label: "deploy · pantry · deployed" },
    { at: 1040, tone: "bad", label: "up · failed" },
  ]);
  expect(toneOfOutcome("deployed")).toBe("good");
  expect(toneOfOutcome("stopped")).toBeUndefined();
});

test("a range the page does not keep reads as the last hour", () => {
  expect(rangeOf("7d")).toBe("7d");
  expect(rangeOf("30d")).toBe("1h");
  expect(rangeOf(undefined)).toBe("1h");
});

test("a preset reads the window that ends now and reaches back its length", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  expect(presetWindow("1h", now)).toEqual({
    since: "2026-10-12T11:00:00.000Z",
  });
  expect(presetWindow("7d", now)).toEqual({
    since: "2026-10-05T12:00:00.000Z",
  });
});

const box = {
  width: 400,
  height: 140,
  pad: { top: 22, right: 6, bottom: 18, left: 40 },
};
const label = (layer: number) => `layer ${layer}`;

test("a stacked layer's peak sits on the layers below it, and the scale reaches above it", () => {
  const layout = chartLayout({
    ...box,
    layers: [
      { average: [90, 90, 90] },
      { average: [10, 10, 10], peak: { index: 1, value: 150 } },
    ],
    from: 0,
    step: 10,
    floor: 25,
    labelOf: label,
  });
  expect(layout.top).toBe(500);
  const flag = layout.flags[0]!;
  expect(flag.y).toBeCloseTo(layout.y(240));
  expect(flag.y).toBeGreaterThanOrEqual(layout.plot.top);
});

/** Pure: whether two label boxes, as the layout estimates them, share any pixel. */
function overlapping(
  layout: ReturnType<typeof chartLayout>,
): [number, number][] {
  const boxes = layout.flags.map((flag) => ({
    x0: flag.labelX,
    x1: flag.labelX + flag.labelWidth,
    y0: flag.labelY - 9,
    y1: flag.labelY + 2,
  }));
  return boxes.flatMap((each, index) =>
    boxes
      .slice(index + 1)
      .flatMap((other, offset): [number, number][] =>
        each.x0 < other.x1 &&
        other.x0 < each.x1 &&
        each.y0 < other.y1 &&
        other.y0 < each.y1
          ? [[index, index + 1 + offset]]
          : [],
      ),
  );
}

test("every layer's peak is flagged, and crowded labels are moved apart inside the chart, never dropped", () => {
  // Twelve Projects peaking together, in the memory chart's 130 pixels.
  const layout = chartLayout({
    ...box,
    height: 130,
    layers: Array.from({ length: 12 }, (_, index) => ({
      average: [1, 1, 1, 1],
      peak: { index: 2, value: 100 - index },
    })),
    from: 0,
    step: 10,
    floor: 25,
    labelOf: (layer) => `project-${layer} 99%`,
  });
  expect(layout.flags.map((flag) => flag.layer).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 12 }, (_, index) => index),
  );
  expect(overlapping(layout)).toEqual([]);
  for (const flag of layout.flags) {
    expect(flag.labelX).toBeGreaterThanOrEqual(0);
    expect(flag.labelX + flag.labelWidth).toBeLessThanOrEqual(box.width);
    expect(flag.labelY - 9).toBeGreaterThanOrEqual(0);
    expect(flag.labelY + 2).toBeLessThanOrEqual(130);
  }
});

test("on a phone-narrow chart a long label beside a late peak turns to the left and stays inside", () => {
  const layout = chartLayout({
    ...box,
    width: 300,
    layers: [
      {
        average: Array.from({ length: 9 }, () => 1),
        peak: { index: 5, value: 100 },
      },
    ],
    from: 0,
    step: 10,
    floor: 25,
    labelOf: () => "b-relay-dashboard 100%",
  });
  const flag = layout.flags[0]!;
  expect(flag.labelX).toBeGreaterThanOrEqual(0);
  expect(flag.labelX + flag.labelWidth).toBeLessThanOrEqual(300);
  expect(flag.labelX + flag.labelWidth).toBeLessThanOrEqual(flag.x);
});

test("points, markers and inspection share one mapping of time to x", () => {
  const layout = chartLayout({
    ...box,
    layers: [{ average: [1, 2, 3] }],
    from: 1000,
    step: 60,
    floor: 25,
    labelOf: label,
  });
  // An Operation half way through the middle point's minute lands on that point, and that point is the one inspected.
  expect(layout.timeX(1090)).toBeCloseTo(layout.pointX(1));
  expect(layout.timeX(1000)).toBe(layout.plot.left);
  expect(layout.timeX(1180)).toBe(layout.plot.right);
  for (const point of [0, 1, 2])
    expect(layout.indexAt(layout.pointX(point))).toBe(point);
  expect(layout.indexAt(-50)).toBe(0);
  expect(layout.indexAt(10_000)).toBe(2);
});
