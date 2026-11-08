import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteUsageHistory } from "../src/adapters/sqlite-usage-history";
import type { UsageHistory } from "../src/runtime/usage-history";
import {
  attempted,
  dueAt,
  maintained,
  pruneBefore,
  type MaintenancePolicy,
} from "../src/runtime/usage-maintenance";
import { createUsageSampler } from "../src/runtime/usage-sampler";

const EVERY: MaintenancePolicy = {
  everyMs: 30_000,
  retryMs: 5000,
  first: "wait",
};
const AT_ONCE: MaintenancePolicy = { ...EVERY, first: "run" };

describe("when maintenance is due", () => {
  test("before the first pass, now or a whole interval from it, as the policy says", () => {
    expect(dueAt(AT_ONCE, {}, 1000)).toBe(1000);
    expect(dueAt(EVERY, {}, 1000)).toBe(31_000);
  });

  test("afterwards, when the last attempt left it due", () => {
    expect(dueAt(EVERY, { dueAt: 7000 }, 1000)).toBe(7000);
    expect(dueAt(AT_ONCE, { dueAt: 7000, failure: "x" }, 1000)).toBe(7000);
  });

  test("again a whole interval after a success, with no failure, and after the retry delay after one, holding it", () => {
    const error = new Error("disk full");
    expect(attempted(EVERY, 1000, { ok: true })).toEqual({ dueAt: 31_000 });
    expect(attempted(EVERY, 1000, { ok: false, error })).toEqual({
      dueAt: 6000,
      failure: error,
    });
  });
});

describe("maintenance", () => {
  test("not due yet does nothing and keeps its failure", async () => {
    const runs: number[] = [];
    const work = async () => {
      runs.push(1);
    };
    expect(await maintained(EVERY, {}, 0, work)).toEqual({ dueAt: 30_000 });
    expect(
      await maintained(EVERY, { dueAt: 5000, failure: "locked" }, 4999, work),
    ).toEqual({ dueAt: 5000, failure: "locked" });
    expect(runs).toEqual([]);
  });

  test("that fails holds the error, is tried again after the retry delay, and recovers", async () => {
    let failing = true;
    const runs: number[] = [];
    const work = (at: number) => async () => {
      runs.push(at);
      if (failing) throw new Error("disk full");
    };
    let state = await maintained(AT_ONCE, {}, 0, work(0));
    expect(state).toEqual({ dueAt: 5000, failure: new Error("disk full") });
    // Still failing until the retry is due; meanwhile nothing runs.
    state = await maintained(AT_ONCE, state, 4999, work(4999));
    expect(state.failure).toEqual(new Error("disk full"));
    failing = false;
    state = await maintained(AT_ONCE, state, 5000, work(5000));
    expect(state).toEqual({ dueAt: 35_000 });
    expect(runs).toEqual([0, 5000]);
  });
});

describe("what a prune removes", () => {
  const retention = { detailHours: 1, retentionDays: 2 };

  test("detail and history past retention", () => {
    expect(
      pruneBefore({ second: 1_000_000, retention, heldMinutes: [] }),
    ).toEqual({
      detailBefore: 1_000_000 - 3600,
      historyBefore: 1_000_000 - 172_800,
    });
  });

  test("never the seconds of a held minute, however old", () => {
    const old = Math.floor((1_000_000 - 7200) / 60);
    expect(
      pruneBefore({
        second: 1_000_000,
        retention,
        heldMinutes: [Math.floor(1_000_000 / 60), old],
      }).detailBefore,
    ).toBe(old * 60);
  });
});

describe("the sampler's history maintenance", () => {
  const START = Date.UTC(2026, 9, 12, 10, 0, 0);
  let directory: string;
  let history: UsageHistory;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rig-usage-maintenance-"));
    history = openSqliteUsageHistory(
      join(directory, "monitor", "usage.sqlite"),
    );
  });
  afterEach(async () => {
    await history.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("with writes and prunes both failing, each recovers on its own schedule, passes report what still fails, and no sample is lost", async () => {
    let seconds = 0;
    const failing = { write: true, prune: true };
    const store: UsageHistory = {
      write: async (minutes) => {
        if (failing.write) throw new Error("disk full");
        return history.write(minutes);
      },
      read: (request) => history.read(request),
      prune: async (input) => {
        if (failing.prune) throw new Error("database is locked");
        return history.prune(input);
      },
      detailFrom: () => history.detailFrom(),
      forget: (projectId) => history.forget(projectId),
      close: async () => {},
    };
    const series = {
      scope: "component",
      projectId: "p-fletcher",
      project: "fletcher",
      targetId: "t-stable",
      target: "stable",
      targetKind: "stable",
      component: "web",
      componentKind: "service",
    } as const;
    const sampled = createUsageSampler({
      reader: {
        intervalMs: 1000,
        kind: "native",
        read: async () =>
          new Map([
            [
              10,
              [{ pid: 11, started: 0, cpuNs: seconds * 1e9, memoryBytes: 1 }],
            ],
          ]),
      },
      processes: async () => [{ series, wrapperPid: 10 }],
      rigProcesses: async () => [],
      history: store,
      retention: async () => ({ detailHours: 24, retentionDays: 7 }),
      now: () => START + seconds * 1000,
      elapsed: () => seconds * 1000,
      cores: 8,
    });
    const outcomes: string[] = [];
    for (; seconds < 70; seconds++) {
      await sampled.pass().then(
        () => outcomes.push("ok"),
        (error: Error) => outcomes.push(error.message),
      );
      if (seconds === 42) failing.write = false;
      if (seconds === 50) failing.prune = false;
    }
    const runs = (from: number, to: number, outcome: string) =>
      Array<string>(to - from).fill(outcome);
    expect(outcomes).toEqual([
      // The first pass prunes and fails; its retry is due a minute later.
      ...runs(0, 30, "database is locked"),
      // The first write is due after 30 seconds and fails too, tried again every 5.
      ...runs(30, 45, "disk full"),
      // The write recovered at its retry; the prune still fails until its own.
      ...runs(45, 60, "database is locked"),
      ...runs(60, 70, "ok"),
    ]);
    await sampled.flush();
    const stored = (
      await history.read({
        filter: { kind: "project", projectId: "p-fletcher" },
        from: START / 1000,
        to: START / 1000 + 70,
        detail: true,
      })
    ).find((each) => each.series.scope === "component");
    // Every sample but the first pass's, which has no CPU to measure from.
    expect(stored!.spans.map((span) => span.at - START / 1000)).toEqual(
      Array.from({ length: 69 }, (_, i) => i + 1),
    );
  });
});
