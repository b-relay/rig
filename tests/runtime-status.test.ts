import { controlledDeadline } from "./controlled-observation-deadline";
import { test, expect } from "bun:test";
import { observeTargets } from "../src/runtime/status";
import type { TargetRecord } from "../src/domain/runtime";
const target = {
  id: "t",
  name: "live",
  kind: "live",
  branch: "main",
  commit: "abc",
  plan: {
    domain: "demo.localhost",
    components: [
      {
        name: "api",
        kind: "managed",
        port: 4444,
        health: "http://localhost:4444",
      },
      { name: "web", kind: "managed", port: 4445 },
    ],
  },
} as TargetRecord;
test("fresh status distinguishes failed health from running without health and retains route/source", async () => {
  const result = await observeTargets(
    [target],
    {
      async process() {
        return { state: "running", pid: 22 };
      },
      async health() {
        return false;
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
    2000,
  );
  expect(result[0]).toMatchObject({
    name: "live",
    state: "degraded",
    branch: "main",
    commit: "abc",
    route: "demo.localhost",
    components: [
      { name: "api", state: "unhealthy" },
      { name: "web", state: "running" },
    ],
  });
});
test("one deadline bounds every concurrent probe and timeouts are unknown", async () => {
  const start = performance.now();
  const result = await observeTargets(
    [target, target],
    {
      async process() {
        return await new Promise(() => {});
      },
      async health() {
        return true;
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
    30,
  );
  expect(performance.now() - start).toBeLessThan(150);
  expect(
    result
      .flatMap((t) => t.components)
      .every(
        (c) =>
          c.state === "unknown" &&
          c.reason ===
            "Observation did not complete before the status deadline.",
      ),
  ).toBe(true);
});
test("a crashed desired-running process is failed with exit evidence while an intentional stop remains stopped", async () => {
  const effects = {
    async process() {
      return { state: "stopped" as const, exitCode: 1 };
    },
    async health() {
      return false;
    },
    async artifact() {
      return "installed" as const;
    },
    async persistent() {
      return true;
    },
  };
  const [crashed, stopped] = await observeTargets(
    [
      { ...target, desired: "running" },
      { ...target, desired: "stopped" },
    ],
    effects,
  );
  expect(crashed).toMatchObject({
    state: "failed",
    components: [
      { state: "failed", exitCode: 1 },
      { state: "failed", exitCode: 1 },
    ],
  });
  expect(stopped).toMatchObject({
    state: "stopped",
    components: [{ state: "stopped" }, { state: "stopped" }],
  });
});
test("managed capabilities own mixed Target health and installed observations retain their distinct states", async () => {
  const mixed = {
    ...target,
    desired: "running",
    plan: {
      ...target.plan,
      proxy: { upstream: "api" },
      components: [
        ...target.plan.components,
        { name: "tool", kind: "installed", entrypoint: "tool.ts" },
      ],
    },
  } as TargetRecord;
  const effects = {
    async process() {
      return { state: "running" as const, pid: 22 };
    },
    async health() {
      return true;
    },
    async artifact() {
      return "unknown" as const;
    },
    async persistent() {
      return true;
    },
  };
  const [report] = await observeTargets([mixed], effects);
  expect(report).toMatchObject({
    state: "running",
    components: [
      { name: "api", state: "healthy", route: "demo.localhost" },
      { name: "web", state: "running" },
      { name: "tool", state: "unknown" },
    ],
  });
  expect(report!.components[1]!.route).toBeUndefined();
  const tools = {
    ...mixed,
    plan: { ...mixed.plan, components: [mixed.plan.components[2]!] },
  };
  expect(
    (
      await observeTargets([tools], {
        ...effects,
        async artifact() {
          return "installed";
        },
      })
    )[0],
  ).toMatchObject({ state: "ready", components: [{ state: "installed" }] });
  expect((await observeTargets([tools], effects))[0]!.state).toBe("unknown");
});
test("timed out observations retain the configured port and route without claiming reachability", async () => {
  const routed = {
    ...target,
    plan: { ...target.plan, proxy: { upstream: "api" } },
  };
  const deadline = controlledDeadline();
  const pending = observeTargets(
    [routed],
    {
      async process() {
        return await new Promise(() => {});
      },
      async health() {
        return false;
      },
      async artifact() {
        return "unknown";
      },
      async persistent() {
        return false;
      },
    },
    10,
    deadline,
  );
  deadline.expire();
  const [report] = await pending;
  expect(report!.components[0]).toMatchObject({
    name: "api",
    port: 4444,
    route: "demo.localhost",
    state: "unknown",
  });
});

test("immediate observation rejection is unknown with a safe failure reason", async () => {
  const [report] = await observeTargets([target], {
    async process() {
      throw new Error("provider unavailable: TOKEN=private-credential");
    },
    async health() {
      return true;
    },
    async artifact() {
      return "installed";
    },
    async persistent() {
      return true;
    },
  });
  expect(report).toMatchObject({
    state: "unknown",
    components: [
      { name: "api", state: "unknown", reason: "Observation failed." },
      { name: "web", state: "unknown", reason: "Observation failed." },
    ],
  });
  expect(JSON.stringify(report)).not.toContain("private-credential");
});

test("controlled common expiry settles every Target and ignores late provider results", async () => {
  const deadline = controlledDeadline();
  const signals: AbortSignal[] = [];
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (value: { state: "running" }) => void;
  const work = new Promise<{ state: "running" }>((resolve) => {
    finish = resolve;
  });
  const pending = observeTargets(
    [target, target],
    {
      process(_target, _component, signal) {
        signals.push(signal);
        if (signals.length === 4) started();
        return work;
      },
      async health() {
        return true;
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
    123,
    deadline,
  );
  await begun;
  expect(signals).toHaveLength(4);
  expect(deadline.budgets).toEqual([123]);
  deadline.expire();
  const reports = await pending;
  expect(
    reports.flatMap((report) => report.components).map((c) => c.reason),
  ).toEqual(
    Array(4).fill("Observation did not complete before the status deadline."),
  );
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(deadline.pending).toBe(false);
  const before = JSON.stringify(reports);
  finish({ state: "running" });
  await Promise.resolve();
  expect(JSON.stringify(reports)).toBe(before);
});

for (const outcome of ["completed", "rejected", "empty"] as const) {
  test(`controlled ${outcome} Status cleans scheduling without waiting for expiry`, async () => {
    const deadline = controlledDeadline();
    const reports = await observeTargets(
      outcome === "empty" ? [] : [target],
      {
        async process() {
          if (outcome === "rejected") throw new Error("private");
          return { state: "stopped", exitCode: 2 };
        },
        async health() {
          return true;
        },
        async artifact() {
          return "installed";
        },
        async persistent() {
          return true;
        },
      },
      100,
      deadline,
    );
    expect(deadline.pending).toBe(false);
    expect(deadline.budgets).toEqual(outcome === "empty" ? [] : [100]);
    if (outcome === "empty") expect(reports).toEqual([]);
    else
      expect(reports[0]!.components[0]).toMatchObject(
        outcome === "rejected"
          ? { state: "unknown", reason: "Observation failed." }
          : { state: "stopped", exitCode: 2 },
      );
  });
}

test("expiry before the queued completion handler wins exactly once", async () => {
  const deadline = controlledDeadline();
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  let complete!: (value: { state: "stopped" }) => void;
  const work = new Promise<{ state: "stopped" }>((resolve) => {
    complete = resolve;
  });
  const reports = observeTargets(
    [target],
    {
      process() {
        started();
        return work;
      },
      async health() {
        return true;
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
    100,
    deadline,
  );
  await begun;
  complete({ state: "stopped" });
  deadline.expire();
  expect((await reports)[0]!.components.map((c) => c.state)).toEqual([
    "unknown",
    "unknown",
  ]);
  expect(deadline.pending).toBe(false);
});

test("completed observations keep their result while the shared budget expires pending health", async () => {
  const deadline = controlledDeadline();
  let healthStarted!: () => void;
  const begun = new Promise<void>((resolve) => {
    healthStarted = resolve;
  });
  const reports = observeTargets(
    [target],
    {
      async process() {
        return { state: "running", pid: 22 };
      },
      health() {
        healthStarted();
        return new Promise(() => {});
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
    100,
    deadline,
  );
  await begun;
  // Let the independently completed web observation settle before expiry.
  await Promise.resolve();
  await Promise.resolve();
  deadline.expire();
  expect((await reports)[0]!.components).toMatchObject([
    { name: "api", state: "unknown" },
    { name: "web", state: "running", pid: 22 },
  ]);
  expect(deadline.budgets).toEqual([100]);
  expect(deadline.pending).toBe(false);
});
