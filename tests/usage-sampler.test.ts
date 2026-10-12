import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteUsageHistory } from "../src/adapters/sqlite-usage-history";
import type { ProcessReading } from "../src/domain/usage-sample";
import type { ProcessUsageReader } from "../src/providers/process-usage";
import type { UsageHistory } from "../src/runtime/usage-history";
import { usageReport } from "../src/runtime/usage-report";
import {
  createUsageSampler,
  type MonitoredProcess,
} from "../src/runtime/usage-sampler";

const SECOND_NS = 1e9;
const START = Date.UTC(2026, 9, 12, 10, 0, 0);
let directory: string;
let history: UsageHistory;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rig-usage-"));
  history = openSqliteUsageHistory(join(directory, "monitor", "usage.sqlite"));
});
afterEach(() => {
  history.close();
  rmSync(directory, { recursive: true, force: true });
});

const component = (
  name: string,
  wrapperPid: number,
  target = { id: "t-stable", name: "stable", kind: "stable" as const },
): MonitoredProcess => ({
  wrapperPid,
  series: {
    scope: "component",
    projectId: "p-fletcher",
    project: "fletcher",
    targetId: target.id,
    target: target.name,
    targetKind: target.kind,
    component: name,
    componentKind: "service",
  },
});

/** A Host whose processes use a fixed share of a core each and a fixed footprint, advanced by `tick`. */
function scriptedHost(
  trees: Record<number, { pid: number; cores: number; memoryBytes: number }[]>,
) {
  let seconds = 0;
  const reader: ProcessUsageReader = {
    intervalMs: 1000,
    kind: "native",
    async read(roots) {
      const found = new Map<number, ProcessReading[]>();
      for (const root of roots) {
        const tree = trees[root];
        if (tree)
          found.set(
            root,
            tree.map((process) => ({
              pid: process.pid,
              cpuNs: process.cores * seconds * SECOND_NS,
              memoryBytes: process.memoryBytes,
            })),
          );
      }
      return found;
    },
  };
  return {
    reader,
    now: () => START + seconds * 1000,
    tick: () => {
      seconds++;
    },
  };
}

describe("the usage sampler", () => {
  test("samples each Component below its wrapper, sums Target, Project and Host totals, and counts wrappers as Rig itself", async () => {
    const host = scriptedHost({
      // rigd (pid 1) with two capture wrappers below it, each running one app.
      1: [
        { pid: 1, cores: 0.05, memoryBytes: 50 },
        { pid: 10, cores: 0.01, memoryBytes: 2 },
        { pid: 11, cores: 0.5, memoryBytes: 400 },
        { pid: 12, cores: 0.25, memoryBytes: 100 },
        { pid: 20, cores: 0.01, memoryBytes: 2 },
        { pid: 21, cores: 2, memoryBytes: 1000 },
      ],
      10: [
        { pid: 10, cores: 0.01, memoryBytes: 2 },
        { pid: 11, cores: 0.5, memoryBytes: 400 },
        { pid: 12, cores: 0.25, memoryBytes: 100 },
      ],
      20: [
        { pid: 20, cores: 0.01, memoryBytes: 2 },
        { pid: 21, cores: 2, memoryBytes: 1000 },
      ],
    });
    const sampler = createUsageSampler({
      reader: host.reader,
      processes: async () => [component("web", 10), component("scheduler", 20)],
      rigProcesses: async () => [1],
      history,
      retention: async () => ({ detailHours: 24, retentionDays: 7 }),
      now: host.now,
      cores: 8,
    });

    await sampler.pass();
    expect(sampler.snapshot().latest).toEqual([]);
    host.tick();
    await sampler.pass();

    const latest = Object.fromEntries(
      sampler
        .snapshot()
        .latest.map((each) => [
          each.series.scope === "component"
            ? each.series.component
            : each.series.scope,
          each.sample,
        ]),
    );
    expect(latest.web!.cpuPercent).toBeCloseTo(75);
    expect(latest.web!.memoryBytes).toBe(500);
    expect(latest.scheduler!.cpuPercent).toBeCloseTo(200);
    expect(latest.target!.cpuPercent).toBeCloseTo(275);
    expect(latest.project!.memoryBytes).toBe(1500);
    expect(latest.rig!.cpuPercent).toBeCloseTo(7);
    expect(latest.rig!.memoryBytes).toBe(54);
    expect(latest.host!.cpuPercent).toBeCloseTo(282);
    expect(latest.host!.memoryBytes).toBe(1554);
  });

  test("buffered minutes are written every 30 seconds, and a report merges them with what is still unwritten", async () => {
    const host = scriptedHost({
      10: [{ pid: 11, cores: 1, memoryBytes: 1024 * 1024 }],
    });
    const sampler = createUsageSampler({
      reader: host.reader,
      processes: async () => [component("web", 10)],
      rigProcesses: async () => [],
      history,
      retention: async () => ({ detailHours: 24, retentionDays: 7 }),
      now: host.now,
      cores: 8,
    });
    for (let i = 0; i < 31; i++) {
      await sampler.pass();
      host.tick();
    }
    const written = await history.read({
      filter: { kind: "project", projectId: "p-fletcher" },
      from: START / 1000,
      to: START / 1000 + 60,
      detail: true,
    });
    const web = written.find((each) => each.series.scope === "component")!;
    expect(web.spans.length).toBe(30);

    for (let i = 0; i < 9; i++) {
      await sampler.pass();
      host.tick();
    }
    const report = await usageReport({
      filter: { kind: "project", projectId: "p-fletcher" },
      range: "1h",
      now: host.now(),
      sampledEvery: 1,
      history,
      snapshot: sampler.snapshot(),
    });
    expect(report.step).toBe(15);
    const reported = report.series.find(
      (each) => each.series.scope === "component",
    )!;
    expect(reported.now).toEqual({ cpuPercent: 100, memoryBytes: 1024 * 1024 });
    expect(reported.summary.cpu).toMatchObject({ low: 100, high: 100 });
    const sampled = reported.points.filter((point) => point.cpu);
    expect(
      sampled.reduce((n, point) => n + (point.cpu ? 1 : 0), 0),
    ).toBeGreaterThanOrEqual(3);
    expect(report.series.map((each) => each.series.scope)).toEqual([
      "project",
      "target",
      "component",
    ]);
  });

  test("a Component that stops has no current sample, while its history stays", async () => {
    const trees: Record<
      number,
      { pid: number; cores: number; memoryBytes: number }[]
    > = {
      10: [{ pid: 11, cores: 1, memoryBytes: 10 }],
    };
    const host = scriptedHost(trees);
    let running = [component("web", 10)];
    const sampler = createUsageSampler({
      reader: host.reader,
      processes: async () => running,
      rigProcesses: async () => [],
      history,
      retention: async () => ({ detailHours: 24, retentionDays: 7 }),
      now: host.now,
      cores: 8,
    });
    for (let i = 0; i < 3; i++) {
      await sampler.pass();
      host.tick();
    }
    delete trees[10];
    running = [];
    for (let i = 0; i < 6; i++) {
      await sampler.pass();
      host.tick();
    }
    const report = await usageReport({
      filter: { kind: "project", projectId: "p-fletcher" },
      range: "1h",
      now: host.now(),
      sampledEvery: 1,
      history,
      snapshot: sampler.snapshot(),
    });
    const web = report.series.find(
      (each) => each.series.scope === "component",
    )!;
    expect(web.now).toBeUndefined();
    expect(web.summary.cpu).toMatchObject({ high: 100 });
  });

  test("when history cannot be written the samples stay buffered and are written by a later pass", async () => {
    const host = scriptedHost({ 10: [{ pid: 11, cores: 1, memoryBytes: 10 }] });
    let failing = true;
    const flaky: UsageHistory = {
      ...history,
      write: async (minutes) => {
        if (failing) throw new Error("disk full");
        return history.write(minutes);
      },
      read: history.read,
      prune: history.prune,
      forget: history.forget,
      close: () => {},
    };
    const sampler = createUsageSampler({
      reader: host.reader,
      processes: async () => [component("web", 10)],
      rigProcesses: async () => [],
      history: flaky,
      retention: async () => ({ detailHours: 24, retentionDays: 7 }),
      now: host.now,
      cores: 8,
    });
    let failures = 0;
    for (let i = 0; i < 95; i++) {
      await sampler.pass().catch(() => failures++);
      host.tick();
      if (i === 70) failing = false;
    }
    expect(failures).toBe(2);
    const written = await history.read({
      filter: { kind: "project", projectId: "p-fletcher" },
      from: START / 1000,
      to: START / 1000 + 120,
      detail: true,
    });
    const web = written.find((each) => each.series.scope === "component")!;
    expect(web.spans.length).toBeGreaterThanOrEqual(88);
  });
});

describe("stored usage history", () => {
  const web = component("web", 10).series;
  const slots = (cpu: number, from = 0, to = 60) =>
    Array.from({ length: 60 }, (_, second) =>
      second >= from && second < to ? { cpu, memory: 100 } : undefined,
    );

  test("a minute written again as it fills, or after a restart, keeps every sample written before", async () => {
    await history.write([
      { series: web, minute: 100, slots: slots(10, 0, 20) },
    ]);
    await history.write([
      { series: web, minute: 100, slots: slots(30, 20, 40) },
    ]);
    const [read] = await history.read({
      filter: { kind: "project", projectId: "p-fletcher" },
      from: 6000,
      to: 6060,
      detail: true,
    });
    expect(read!.spans.length).toBe(40);
    const [minute] = await history.read({
      filter: { kind: "project", projectId: "p-fletcher" },
      from: 6000,
      to: 6060,
      detail: false,
    });
    expect(minute!.spans[0]!.histograms.cpu).toMatchObject({
      count: 40,
      low: 10,
      high: 30,
    });
  });

  test("pruning drops detail and history on their own schedules, and forgetting a Project drops all of its history", async () => {
    await history.write([
      { series: web, minute: 100, slots: slots(10) },
      { series: web, minute: 200, slots: slots(10) },
      { series: { scope: "host" }, minute: 200, slots: slots(10) },
    ]);
    await history.prune({ detailBefore: 200 * 60, historyBefore: 150 * 60 });
    const read = (detail: boolean) =>
      history.read({
        filter: { kind: "project", projectId: "p-fletcher" },
        from: 0,
        to: 300 * 60,
        detail,
      });
    expect(
      (await read(true))[0]!.spans.map((span) => Math.floor(span.at / 60)),
    ).toContain(200);
    expect(
      (await read(true))[0]!.spans.some((span) => span.at < 200 * 60),
    ).toBe(false);
    expect((await read(false))[0]!.spans.map((span) => span.at)).toEqual([
      200 * 60,
    ]);

    await history.forget("p-fletcher");
    expect(await read(false)).toEqual([]);
    const hostRead = await history.read({
      filter: { kind: "host" },
      from: 0,
      to: 300 * 60,
      detail: false,
    });
    expect(hostRead.map((each) => each.series.scope)).toEqual(["host"]);
  });

  test("history survives reopening the database", async () => {
    await history.write([{ series: web, minute: 100, slots: slots(10) }]);
    history.close();
    history = openSqliteUsageHistory(
      join(directory, "monitor", "usage.sqlite"),
    );
    const [read] = await history.read({
      filter: { kind: "project", projectId: "p-fletcher" },
      from: 6000,
      to: 6060,
      detail: false,
    });
    expect(read!.series).toEqual(web);
  });
});
