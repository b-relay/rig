import { controlledDeadline } from "./controlled-observation-deadline";
import { test, expect } from "bun:test";
import { observeTargets } from "../src/runtime/status";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
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
        return { ready: false, reason: "probe failed" };
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
    2000,
    timerObservationDeadline,
  );
  expect(result[0]).toMatchObject({
    name: "live",
    state: "unhealthy",
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
        return { ready: true as const };
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
    30,
    timerObservationDeadline,
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
test("a crashed desired-running process is failed with the exit evidence of its recorded start, an unrecorded one is failed as unknown, and an intentional stop remains stopped", async () => {
  const effects = {
    async process() {
      return { state: "stopped" as const, exitCode: 1, incarnation: "start-1" };
    },
    async health() {
      return { ready: false, reason: "probe failed" };
    },
    async artifact() {
      return "installed" as const;
    },
    async persistent() {
      return true;
    },
  };
  const run = {
    deployment: "/deployments/abc",
    intent: "running" as const,
    incarnation: "start-1",
    attempts: [],
  };
  const recorded = {
    ...target,
    desired: "running" as const,
    plan: {
      ...target.plan,
      workspacePath: "/deployments/abc",
      components: target.plan.components.map((component) => ({
        ...component,
        restart: "no" as const,
      })),
    },
    services: { api: run, web: run },
  };
  const [crashed, unrecorded, stopped] = await observeTargets(
    [
      recorded,
      { ...target, desired: "running" },
      { ...target, desired: "stopped" },
    ],
    effects,
    2000,
    timerObservationDeadline,
  );
  expect(crashed).toMatchObject({
    state: "failed",
    components: [
      { state: "failed", exit: "failed", exitCode: 1 },
      { state: "failed", exit: "failed", exitCode: 1 },
    ],
  });
  expect(unrecorded).toMatchObject({
    state: "failed",
    components: [
      { state: "failed", exit: "unknown" },
      { state: "failed", exit: "unknown" },
    ],
  });
  expect(unrecorded!.components[0]).not.toHaveProperty("exitCode");
  expect(stopped).toMatchObject({
    state: "stopped",
    components: [{ state: "stopped" }, { state: "stopped" }],
  });
});
test("an installed Component that cannot be observed degrades a Target whose processes run, and installed observations retain their distinct states", async () => {
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
      return { ready: true as const };
    },
    async artifact() {
      return "unknown" as const;
    },
    async persistent() {
      return true;
    },
  };
  const [report] = await observeTargets(
    [mixed],
    effects,
    2000,
    timerObservationDeadline,
  );
  expect(report).toMatchObject({
    state: "degraded",
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
      await observeTargets(
        [tools],
        {
          ...effects,
          async artifact() {
            return "installed";
          },
        },
        2000,
        timerObservationDeadline,
      )
    )[0],
  ).toMatchObject({ state: "ready", components: [{ state: "installed" }] });
  expect(
    (await observeTargets([tools], effects, 2000, timerObservationDeadline))[0]!
      .state,
  ).toBe("unknown");
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
        return { ready: false, reason: "probe failed" };
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
  const [report] = await observeTargets(
    [target],
    {
      async process() {
        throw new Error("provider unavailable: TOKEN=private-credential");
      },
      async health() {
        return { ready: true as const };
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
    2000,
    timerObservationDeadline,
  );
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
        return { ready: true as const };
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
          return { ready: true as const };
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
          : { state: "stopped" },
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
        return { ready: true as const };
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
test("a running component keeps the reason its provider attached, and the rendered status prints it", async () => {
  const { renderStatus } = await import("../src/cli/output");
  const result = await observeTargets(
    [target],
    {
      async process() {
        return {
          state: "running",
          pid: 22,
          reason: "Target output is not being recorded in /logs/live.",
        };
      },
      async health() {
        return { ready: true as const };
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
    2000,
    timerObservationDeadline,
  );
  expect(result[0]!.components).toEqual([
    expect.objectContaining({
      name: "api",
      state: "healthy",
      reason: "Target output is not being recorded in /logs/live.",
    }),
    expect.objectContaining({
      name: "web",
      state: "running",
      reason: "Target output is not being recorded in /logs/live.",
    }),
  ]);
  expect(renderStatus({ project: "demo", targets: result })).toContain(
    "    Target output is not being recorded in /logs/live.",
  );
});

test("the Target aggregate counts every Component: missing storage beside a healthy process is degraded, and a running process that fails its check is unhealthy, not failed", async () => {
  const mixed = {
    ...target,
    plan: {
      domain: "demo.localhost",
      components: [
        {
          name: "web",
          kind: "managed",
          port: 4445,
          health: "http://localhost:4445",
        },
        { name: "db", kind: "sqlite" },
        { name: "cli", kind: "installed" },
      ],
    },
  } as TargetRecord;
  const observe = (ready: boolean, artifact: "installed" | "missing") =>
    observeTargets(
      [mixed],
      {
        async process() {
          return { state: "running", pid: 22 };
        },
        async health() {
          return ready ? { ready: true } : { ready: false, reason: "HTTP 503" };
        },
        async artifact() {
          return artifact;
        },
        async persistent() {
          return artifact === "installed";
        },
      },
      2000,
      timerObservationDeadline,
    );
  expect((await observe(true, "installed"))[0]?.state).toBe("healthy");
  expect((await observe(true, "missing"))[0]?.state).toBe("degraded");
  expect((await observe(false, "installed"))[0]?.state).toBe("unhealthy");
  expect((await observe(false, "missing"))[0]?.state).toBe("degraded");
});
