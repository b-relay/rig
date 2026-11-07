import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteUsageHistory } from "../src/adapters/sqlite-usage-history";
import { histogramsOf } from "../src/domain/usage-minute";
import type { RecordedSpan } from "../src/domain/usage-summary";
import {
  seriesKey,
  type UsageHistory,
  type UsageSeries,
} from "../src/runtime/usage-history";
import type { SeriesSpans } from "../src/runtime/usage-overlay";
import { reportSeries, usageReport } from "../src/runtime/usage-report";
import { usageReportPlan } from "../src/runtime/usage-report-plan";

const START = Date.UTC(2026, 9, 12, 10, 0, 0) / 1000;
const MINUTE = START / 60;
const target = {
  projectId: "p-fletcher",
  project: "fletcher",
  targetId: "t-stable",
  target: "stable",
  targetKind: "stable",
} as const;
const component = (name: string): UsageSeries => ({
  scope: "component",
  ...target,
  component: name,
  componentKind: "service",
});
const web = component("web");
const worker = component("worker");
const span = (at: number, cpu: number): RecordedSpan => ({
  at,
  histograms: histogramsOf([{ cpu, memory: 1 }])!,
});
const spans = (
  ...entries: [UsageSeries, RecordedSpan[]][]
): Map<string, SeriesSpans> =>
  new Map(
    entries.map(([series, each]) => [
      seriesKey(series),
      { series, spans: each },
    ]),
  );

describe("report series", () => {
  // A day, read by the minute, ending half way into a minute whose seconds are kept.
  const plan = usageReportPlan({
    since: START,
    until: START + 86_400 - 30,
    nowSecond: START + 90_000,
    detailSince: START,
  });

  test("a series with a fresh sample is listed with it even with nothing recorded, and one without has no `now`", () => {
    const series = reportSeries({
      plan,
      chart: spans([web, [span(START + 60, 100)]]),
      boundaries: [],
      fresh: [
        {
          series: worker,
          sample: { cpuPercent: 5, memoryBytes: 1024 },
          at: START + 90_000,
        },
      ],
    });
    expect(series.map((each) => [each.series, each.now])).toEqual([
      [web, undefined],
      [worker, { cpuPercent: 5, memoryBytes: 1024 }],
    ]);
    expect(series[1]!.summary).toEqual({});
  });

  test("series are ordered as the pages list them", () => {
    const project: UsageSeries = { scope: "project", ...target };
    const other: UsageSeries = {
      scope: "project",
      projectId: "p-alder",
      project: "alder",
    };
    const preview: UsageSeries = {
      scope: "target",
      ...target,
      targetId: "t-pr",
      target: "pr-1",
      targetKind: "preview",
    };
    const stable: UsageSeries = { scope: "target", ...target };
    const ordered = reportSeries({
      plan,
      chart: spans(
        [worker, []],
        [preview, []],
        [project, []],
        [web, []],
        [stable, []],
        [other, []],
        [{ scope: "rig" }, []],
        [{ scope: "host" }, []],
      ),
      boundaries: [],
      fresh: [],
    }).map((each) => each.series);
    expect(ordered).toEqual([
      { scope: "host" },
      { scope: "rig" },
      other,
      project,
      stable,
      preview,
      web,
      worker,
    ]);
  });

  test("each series' summary reads a boundary minute by the second only where that series has its seconds", () => {
    const boundary = plan.boundaries[0]!;
    expect(boundary).toBe(START + 86_400 - 60);
    // Both series spiked at the minute's last second, after the window ends.
    const minute = {
      at: boundary,
      histograms: histogramsOf([
        { cpu: 990, memory: 1 },
        { cpu: 100, memory: 1 },
      ])!,
    };
    const series = reportSeries({
      plan,
      chart: spans([web, [minute]], [worker, [minute]]),
      boundaries: [
        {
          start: boundary,
          seconds: spans([web, [span(boundary + 1, 100)]]),
        },
      ],
      fresh: [],
    });
    expect(series.map((each) => each.summary.cpu?.high)).toEqual([10, 99]);
    // The chart still draws the whole minute for both.
    expect(series.map((each) => each.points.at(-1)?.cpu?.high)).toEqual([
      99, 99,
    ]);
  });
});

describe("usage reports over stored history", () => {
  let directory: string;
  let history: UsageHistory;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rig-usage-report-"));
    history = openSqliteUsageHistory(
      join(directory, "monitor", "usage.sqlite"),
    );
  });
  afterEach(async () => {
    await history.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a boundary minute is replaced by its seconds per series: one held, one stored, one kept only as history", async () => {
    const minute = MINUTE + 360;
    // Each series spiked at the last second of the minute the window ends inside, after it ends.
    const spikeLast = Array.from({ length: 60 }, (_, second) => ({
      cpu: second === 59 ? 990 : 100,
      memory: 100,
    }));
    const cron = component("cron");
    await history.write([
      { series: web, minute, slots: spikeLast },
      { series: cron, minute, slots: spikeLast },
    ]);
    // The store has the cron minute only as history: its seconds are gone, though detail retention covers it.
    const store: UsageHistory = {
      write: (minutes) => history.write(minutes),
      read: async (request) =>
        (await history.read(request)).filter(
          (each) =>
            !request.detail || seriesKey(each.series) !== seriesKey(cron),
        ),
      prune: (input) => history.prune(input),
      detailFrom: () => history.detailFrom(),
      forget: (projectId) => history.forget(projectId),
      close: async () => {},
    };
    const report = await usageReport({
      filter: { kind: "project", projectId: "p-fletcher" },
      window: { since: START, until: minute * 60 + 30 },
      now: (START + 7 * 3600) * 1000,
      detailSince: START,
      sampledEvery: 1,
      history: store,
      snapshot: {
        latest: [],
        // The worker's minute is held, not written yet.
        pending: [{ series: worker, minute, slots: spikeLast }],
      },
    });
    expect(report.step).toBeGreaterThanOrEqual(60);
    const high = Object.fromEntries(
      report.series.map((each) => [
        each.series.scope === "component" ? each.series.component : "",
        each.summary.cpu?.high,
      ]),
    );
    expect(high).toEqual({ cron: 99, web: 10, worker: 10 });
  });
});
