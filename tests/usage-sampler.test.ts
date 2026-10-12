import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedUsageHistory } from "../src/adapters/guarded-usage-history";
import { openSqliteUsageHistory } from "../src/adapters/sqlite-usage-history";
import type { ProcessReading } from "../src/domain/usage-sample";
import type { ProcessUsageReader } from "../src/providers/process-usage";
import type {
  RecordedMinute,
  UsageHistory,
} from "../src/runtime/usage-history";
import { usageReport } from "../src/runtime/usage-report";
import {
  createUsageSampler,
  type MonitoredProcess,
} from "../src/runtime/usage-sampler";

const START = Date.UTC(2026, 9, 12, 10, 0, 0);
let directory: string;
let history: UsageHistory;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rig-usage-"));
  history = openSqliteUsageHistory(join(directory, "monitor", "usage.sqlite"));
});
afterEach(async () => {
  await history.close();
  rmSync(directory, { recursive: true, force: true });
});

const PROJECT = { kind: "project", projectId: "p-fletcher" } as const;
const component = (
  name: string,
  wrapperPid: number,
  componentKind: "service" | "job" = "service",
): MonitoredProcess => ({
  wrapperPid,
  series: {
    scope: "component",
    projectId: "p-fletcher",
    project: "fletcher",
    targetId: "t-stable",
    target: "stable",
    targetKind: "stable",
    component: name,
    componentKind,
  },
});

interface ScriptedProcess {
  pid: number;
  /** Share of one core the process keeps busy. */
  cores: number;
  memoryBytes: number;
}

/** A Host whose processes each use a fixed share of a core, advanced a second at a time by `tick`. `trees` maps a root
 * pid to its tree and may change between ticks. */
function scriptedHost(trees: Record<number, ScriptedProcess[]>) {
  let seconds = 0;
  let delay = 0;
  let extraMs = 0;
  const reader: ProcessUsageReader = {
    intervalMs: 1000,
    kind: "native",
    async read(roots) {
      extraMs += delay;
      const found = new Map<number, ProcessReading[]>();
      for (const root of roots) {
        const tree = trees[root];
        if (tree)
          found.set(
            root,
            tree.map((process) => ({
              pid: process.pid,
              started: 0,
              cpuNs: process.cores * (seconds * 1000 + extraMs) * 1e6,
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
    elapsed: () => seconds * 1000 + extraMs,
    tick: () => {
      seconds++;
    },
    /** Every later read takes this long on the monotonic clock. */
    slowReads: (ms: number) => {
      delay = ms;
    },
  };
}

function sampler(
  host: ReturnType<typeof scriptedHost>,
  options: {
    processes: () => readonly MonitoredProcess[];
    rig?: readonly number[];
    history?: UsageHistory;
    reader?: ProcessUsageReader;
  },
) {
  return createUsageSampler({
    reader: options.reader ?? host.reader,
    processes: async () => options.processes(),
    rigProcesses: async () => options.rig ?? [],
    history: options.history ?? history,
    retention: async () => ({ detailHours: 24, retentionDays: 7 }),
    now: host.now,
    elapsed: host.elapsed,
    cores: 8,
  });
}

async function run(
  host: ReturnType<typeof scriptedHost>,
  sampled: ReturnType<typeof sampler>,
  passes: number,
) {
  for (let i = 0; i < passes; i++) {
    await sampled.pass();
    host.tick();
  }
}

const latestBy = (sampled: ReturnType<typeof sampler>) =>
  Object.fromEntries(
    sampled
      .snapshot()
      .latest.map((each) => [
        each.series.scope === "component"
          ? each.series.component
          : each.series.scope,
        each.sample,
      ]),
  );

/** The seconds (from START) the store holds for the web Component, from `from` up to `to`. */
async function storedSeconds(from: number, to: number) {
  const read = await history.read({
    filter: PROJECT,
    from: START / 1000 + from,
    to: START / 1000 + to,
    detail: true,
  });
  return (
    read.find((each) => each.series.scope === "component")?.spans ?? []
  ).map((span) => span.at - START / 1000);
}

/** A history that records what it is asked to write, and fails writes while `failing()` says so. */
function watched(failing: () => boolean = () => false) {
  const writes: RecordedMinute[][] = [];
  const store: UsageHistory = {
    write: async (minutes) => {
      if (failing()) throw new Error("disk full");
      writes.push([...minutes]);
      return history.write(minutes);
    },
    read: (request) => history.read(request),
    prune: (input) => history.prune(input),
    forget: (id) => history.forget(id),
    close: async () => {},
  };
  return { store, writes };
}

const seconds = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);

describe("the usage sampler", () => {
  test("samples each Component below its wrapper, sums Target, Project and Host totals, and counts wrappers as Rig itself", async () => {
    const wrapperA = { pid: 10, cores: 0.01, memoryBytes: 2 };
    const appA = [
      { pid: 11, cores: 0.5, memoryBytes: 400 },
      { pid: 12, cores: 0.25, memoryBytes: 100 },
    ];
    const wrapperB = { pid: 20, cores: 0.01, memoryBytes: 2 };
    const appB = [{ pid: 21, cores: 2, memoryBytes: 1000 }];
    const host = scriptedHost({
      // rigd (pid 1) with two capture wrappers below it, each running one app.
      1: [
        { pid: 1, cores: 0.05, memoryBytes: 50 },
        wrapperA,
        ...appA,
        wrapperB,
        ...appB,
      ],
      10: [wrapperA, ...appA],
      20: [wrapperB, ...appB],
    });
    const sampled = sampler(host, {
      processes: () => [component("web", 10), component("scheduler", 20)],
      rig: [1],
    });
    await sampled.pass();
    expect(sampled.snapshot().latest).toEqual([]);
    host.tick();
    await sampled.pass();
    const latest = latestBy(sampled);
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

  test("a wrapper rigd adopted after a restart, no longer under rigd, still counts as Rig itself", async () => {
    const wrapper = { pid: 10, cores: 0.1, memoryBytes: 8 };
    const host = scriptedHost({
      1: [{ pid: 1, cores: 0.1, memoryBytes: 50 }],
      10: [wrapper, { pid: 11, cores: 1, memoryBytes: 400 }],
    });
    const sampled = sampler(host, {
      processes: () => [component("web", 10)],
      rig: [1],
    });
    await run(host, sampled, 2);
    expect(latestBy(sampled).rig!.cpuPercent).toBeCloseTo(20);
    expect(latestBy(sampled).rig!.memoryBytes).toBe(58);
  });

  test("a Job run that starts under rigd between refreshes is found within a second, not counted as Rig itself", async () => {
    const trees: Record<number, ScriptedProcess[]> = {
      1: [{ pid: 1, cores: 0.1, memoryBytes: 50 }],
    };
    const host = scriptedHost(trees);
    let running: MonitoredProcess[] = [];
    const sampled = sampler(host, { processes: () => running, rig: [1] });
    await run(host, sampled, 2);
    // A four-second backup starts under rigd right after a refresh.
    const job = [
      { pid: 30, cores: 0.01, memoryBytes: 2 },
      { pid: 31, cores: 1, memoryBytes: 300 },
    ];
    trees[30] = job;
    trees[1] = [...trees[1]!, ...job];
    running = [component("backup", 30, "job")];
    await run(host, sampled, 3);
    const latest = latestBy(sampled);
    expect(latest.backup!.cpuPercent).toBeCloseTo(100);
    expect(latest.rig!.memoryBytes).toBe(52);
  });

  test("a helper rigd keeps running is looked into once more, while a Job run that starts beside it is still found within a second", async () => {
    const trees: Record<number, ScriptedProcess[]> = {
      1: [
        { pid: 1, cores: 0.1, memoryBytes: 50 },
        // A command healthcheck that stays alive across passes.
        { pid: 40, cores: 0.05, memoryBytes: 4 },
      ],
    };
    const host = scriptedHost(trees);
    let running: MonitoredProcess[] = [];
    let discoveries = 0;
    const sampled = sampler(host, {
      processes: () => {
        discoveries++;
        return running;
      },
      rig: [1],
    });
    await run(host, sampled, 4);
    // The second pass looks again to confirm the helper is Rig's own; after that it never sends the sampler back.
    expect(discoveries).toBe(2);
    const job = [
      { pid: 30, cores: 0.01, memoryBytes: 2 },
      { pid: 31, cores: 1, memoryBytes: 300 },
    ];
    trees[30] = job;
    trees[1] = [...trees[1]!, ...job];
    running = [component("backup", 30, "job")];
    await run(host, sampled, 2);
    expect(discoveries).toBe(3);
    expect(latestBy(sampled).backup!.cpuPercent).toBeCloseTo(100);
  });

  test("a Job run that starts between a look at rigd's records and the read that follows it is found at the next look", async () => {
    const trees: Record<number, ScriptedProcess[]> = {
      1: [{ pid: 1, cores: 0.1, memoryBytes: 50 }],
    };
    const host = scriptedHost(trees);
    const job = [
      { pid: 30, cores: 0.01, memoryBytes: 2 },
      { pid: 31, cores: 1, memoryBytes: 300 },
    ];
    let running: MonitoredProcess[] = [];
    let discoveries = 0;
    const sampled = sampler(host, {
      processes: () => {
        discoveries++;
        // The Job starts just after the first look, before the process tree is read.
        const seen = running;
        if (discoveries === 1) {
          trees[30] = job;
          trees[1] = [...trees[1]!, ...job];
          running = [component("backup", 30, "job")];
        }
        return seen;
      },
      rig: [1],
    });
    await run(host, sampled, 3);
    expect(discoveries).toBe(2);
    expect(latestBy(sampled).backup!.cpuPercent).toBeCloseTo(100);
    expect(latestBy(sampled).rig!.memoryBytes).toBe(52);
  });

  test("CPU is divided by the time between the reads that returned the counters, however long a read takes", async () => {
    const host = scriptedHost({ 10: [{ pid: 11, cores: 1, memoryBytes: 1 }] });
    const sampled = sampler(host, { processes: () => [component("web", 10)] });
    await run(host, sampled, 2);
    host.slowReads(400);
    for (let i = 0; i < 2; i++) {
      await run(host, sampled, 1);
      expect(latestBy(sampled).web!.cpuPercent).toBeCloseTo(100);
    }
  });

  test("changed minutes are written every 30 seconds, every sample exactly once, and a minute that went quiet is not written again", async () => {
    const trees: Record<number, ScriptedProcess[]> = {
      10: [{ pid: 11, cores: 1, memoryBytes: 1024 }],
    };
    const host = scriptedHost(trees);
    const { store, writes } = watched();
    let running = [component("web", 10)];
    const sampled = sampler(host, { processes: () => running, history: store });
    await run(host, sampled, 31);
    // The first pass only learns the tree; seconds 1 to 30 are stored.
    expect(await storedSeconds(0, 120)).toEqual(seconds(1, 31));
    // On into the next minute, then the Component stops.
    await run(host, sampled, 59);
    delete trees[10];
    running = [];
    await run(host, sampled, 70);
    expect(await storedSeconds(0, 120)).toEqual(seconds(1, 90));
    const webWrites = writes
      .flat()
      .filter((minute) => minute.series.scope === "component")
      .map((minute) => minute.minute - Math.floor(START / 60_000));
    // Minute 0 at 30 s and again when it finished; minute 1 at 60 s and 90 s; nothing once it went quiet.
    expect(webWrites).toEqual([0, 0, 1, 1]);
  });

  test("while history cannot be written every pass fails, so doctor keeps the notice, and the samples are written once it can", async () => {
    const host = scriptedHost({ 10: [{ pid: 11, cores: 1, memoryBytes: 10 }] });
    let failing = true;
    const { store } = watched(() => failing);
    const sampled = sampler(host, {
      processes: () => [component("web", 10)],
      history: store,
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 52; i++) {
      await sampled.pass().then(
        () => outcomes.push("ok"),
        () => outcomes.push("failed"),
      );
      host.tick();
      if (i === 44) failing = false;
    }
    expect(outcomes.slice(0, 30).every((each) => each === "ok")).toBe(true);
    expect(outcomes.slice(30, 45).every((each) => each === "failed")).toBe(
      true,
    );
    expect(outcomes.at(-1)).toBe("ok");
    expect(await storedSeconds(0, 60)).toEqual(seconds(1, 46));
  });

  test("while pruning fails every pass fails, until a retry a minute later succeeds", async () => {
    const host = scriptedHost({ 10: [{ pid: 11, cores: 1, memoryBytes: 10 }] });
    let failing = true;
    const store: UsageHistory = {
      ...watched().store,
      prune: async (input) => {
        if (failing) throw new Error("database is locked");
        return history.prune(input);
      },
    };
    const sampled = sampler(host, {
      processes: () => [component("web", 10)],
      history: store,
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 70; i++) {
      await sampled.pass().then(
        () => outcomes.push("ok"),
        () => outcomes.push("failed"),
      );
      host.tick();
      if (i === 5) failing = false;
    }
    // The first pass prunes and fails; the retry is due a minute later.
    expect(outcomes.slice(0, 60).every((each) => each === "failed")).toBe(true);
    expect(outcomes.slice(60).every((each) => each === "ok")).toBe(true);
  });

  test("a forget during a pass waits for it, and nothing that pass sampled comes back afterwards", async () => {
    const host = scriptedHost({ 10: [{ pid: 11, cores: 1, memoryBytes: 10 }] });
    let gate: Promise<void> | undefined;
    let entered: (() => void) | undefined;
    const gated: ProcessUsageReader = {
      ...host.reader,
      read: async (roots) => {
        entered?.();
        await gate;
        return host.reader.read(roots);
      },
    };
    const sampled = sampler(host, {
      processes: () => [component("web", 10)],
      reader: gated,
    });
    await run(host, sampled, 3);
    await sampled.flush();
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    const reading = new Promise<void>((resolve) => (entered = resolve));
    const pass = sampled.pass();
    // The pass is inside its read when the forget arrives.
    await reading;
    const forgotten = sampled.forget("p-fletcher");
    open();
    await pass;
    await forgotten;
    await sampled.flush();
    expect(await storedSeconds(0, 60)).toEqual([]);
    expect(
      sampled
        .snapshot()
        .pending.filter((minute) => "projectId" in minute.series),
    ).toEqual([]);
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
      { series: web, minute: 170, slots: slots(20) },
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
    // Minute 170 has lost its seconds but keeps its distribution; minute 100 has lost both.
    const minutes = (await read(false))[0]!.spans;
    expect(minutes.map((span) => span.at)).toEqual([170 * 60, 200 * 60]);
    expect(minutes[0]!.histograms.cpu).toMatchObject({
      count: 60,
      low: 20,
      high: 20,
    });

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
    await history.close();
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

describe("usage reports", () => {
  const web = component("web", 10).series;
  const minute = Math.floor(START / 60_000);
  const slots = (cpu: number, from: number, to: number) =>
    Array.from({ length: 60 }, (_, second) =>
      second >= from && second < to ? { cpu, memory: 100 } : undefined,
    );
  const reported = async (range: "1h" | "24h") =>
    (
      await usageReport({
        filter: PROJECT,
        window: {
          since: START / 1000 + 40 - (range === "1h" ? 3600 : 86_400),
        },
        detailSince: START / 1000 - 86_400,
        now: START + 40_000,
        sampledEvery: 1,
        history,
        snapshot: {
          latest: [],
          pending: [{ series: web, minute, slots: slots(100, 20, 40) }],
        },
      })
    ).series.find((each) => each.series.scope === "component")!;

  test("on the minute charts, a minute held across a restart keeps the seconds stored before it", async () => {
    // 100% for seconds 0–19 was written before rigd restarted; the new rigd holds 10% for seconds 20–39.
    await history.write([{ series: web, minute, slots: slots(1000, 0, 20) }]);
    expect((await reported("24h")).summary.cpu).toMatchObject({
      low: 10,
      high: 100,
      average: 55,
    });
  });

  test("on the hour chart, a held second replaces the stored one and the other stored seconds stay", async () => {
    await history.write([{ series: web, minute, slots: slots(1000, 0, 30) }]);
    expect((await reported("1h")).summary.cpu).toMatchObject({
      low: 10,
      high: 100,
      average: 55,
    });
  });
});

describe("usage report windows", () => {
  const web = component("web", 10).series;
  const minute = Math.floor(START / 60_000);
  const full = (cpu: number) =>
    Array.from({ length: 60 }, () => ({ cpu, memory: 100 }));

  test("a closed window in the past covers just that span, in steps sized to it, and nothing after it", async () => {
    await history.write([
      { series: web, minute, slots: full(100) },
      { series: web, minute: minute + 5, slots: full(900) },
    ]);
    const report = await usageReport({
      filter: PROJECT,
      window: { since: START / 1000, until: START / 1000 + 120 },
      detailSince: START / 1000 - 3600,
      now: START + 3_600_000,
      sampledEvery: 1,
      history,
      snapshot: { latest: [], pending: [] },
    });
    expect(report.step).toBe(1);
    expect(report.until).toBe(START / 1000 + 120);
    const web_ = report.series.find(
      (each) => each.series.scope === "component",
    )!;
    expect(web_.summary.cpu).toMatchObject({ low: 10, high: 10 });
  });

  test("a short window older than the 1-second detail reads the per-minute history instead of coming back empty", async () => {
    await history.write([{ series: web, minute, slots: full(250) }]);
    await history.prune({
      detailBefore: START / 1000 + 3600,
      historyBefore: START / 1000 - 3600,
    });
    const report = await usageReport({
      filter: PROJECT,
      window: { since: START / 1000, until: START / 1000 + 600 },
      detailSince: START / 1000 + 3600,
      now: START + 7_200_000,
      sampledEvery: 1,
      history,
      snapshot: { latest: [], pending: [] },
    });
    expect(report.step).toBe(60);
    const web_ = report.series.find(
      (each) => each.series.scope === "component",
    )!;
    expect(web_.summary.cpu).toMatchObject({ low: 25, high: 25 });
  });
});

describe("the guarded history", () => {
  test("a store that cannot be opened fails each call with a hint and is tried again at the next, never as rigd starts", async () => {
    mkdirSync(join(directory, "blocked"));
    const path = join(directory, "blocked", "usage.sqlite");
    writeFileSync(path, "not a database at all, just bytes");
    let opens = 0;
    const guarded = guardedUsageHistory({
      open: () => {
        opens++;
        return openSqliteUsageHistory(path);
      },
      path,
    });
    expect(opens).toBe(0);
    const read = () =>
      guarded.read({ filter: PROJECT, from: 0, to: 60, detail: false });
    await expect(read()).rejects.toMatchObject({ code: "MONITOR_STORAGE" });
    rmSync(path);
    expect(await read()).toEqual([]);
    expect(opens).toBe(2);
    await guarded.close();
  });

  test("closing waits for a read in progress, and a read after it is refused", async () => {
    let finish!: () => void;
    let closed = false;
    const slow: UsageHistory = {
      ...history,
      read: async () => {
        await new Promise<void>((resolve) => (finish = resolve));
        if (closed) throw new Error("read a closed database");
        return [];
      },
      close: async () => {
        closed = true;
      },
    };
    const guarded = guardedUsageHistory({ open: () => slow, path: "x" });
    const request = { filter: PROJECT, from: 0, to: 60, detail: false };
    const reading = guarded.read(request);
    const closing = guarded.close();
    await Bun.sleep(5);
    expect(closed).toBe(false);
    finish();
    expect(await reading).toEqual([]);
    await closing;
    expect(closed).toBe(true);
    await expect(guarded.read(request)).rejects.toMatchObject({
      code: "MONITOR_UNAVAILABLE",
    });
  });
});
