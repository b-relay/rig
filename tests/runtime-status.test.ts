import { controlledDeadline } from "./controlled-observation-deadline";
import { test, expect } from "bun:test";
import {
  componentBase,
  observeTargets,
  settledComponent,
  targetReport,
} from "../src/runtime/status";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
import type { TargetRecord } from "../src/domain/runtime";
const target = {
  id: "t",
  name: "stable",
  kind: "stable",
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
      async listening() {
        return [];
      },
      async persistent() {
        return true;
      },
    },
    2000,
    timerObservationDeadline,
  );
  expect(result[0]).toMatchObject({
    name: "stable",
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
      async listening() {
        return [];
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
test("a crashed desired-running process is failed with the exit evidence of its recorded start, an unrecorded one is unknown (starting again under always, failed otherwise), and an intentional stop remains stopped", async () => {
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
    async listening() {
      return [];
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
  const [crashed, unrecorded, unrecordedOnFailure, stopped] =
    await observeTargets(
      [
        recorded,
        { ...target, desired: "running" },
        {
          ...target,
          desired: "running",
          plan: {
            ...target.plan,
            components: target.plan.components.map((component) => ({
              ...component,
              restart: "on-failure" as const,
            })),
          },
        },
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
    state: "starting",
    components: [
      { state: "starting", exit: "unknown" },
      { state: "starting", exit: "unknown" },
    ],
  });
  expect(unrecorded!.components[0]!.reason).toContain(
    "started again once it is verified gone and its ports are free",
  );
  expect(unrecordedOnFailure).toMatchObject({
    state: "failed",
    components: [
      { state: "failed", exit: "unknown" },
      { state: "failed", exit: "unknown" },
    ],
  });
  expect(unrecordedOnFailure!.components[0]!.reason).toContain(
    "so it was not restarted",
  );
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
    async listening() {
      return [];
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
      async listening() {
        return [];
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
      async listening() {
        return [];
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
      async listening() {
        return [];
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
        async listening() {
          return [];
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
      async listening() {
        return [];
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
      async listening() {
        return [];
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
      async listening() {
        return [];
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
  expect(
    renderStatus({ project: "demo", targets: result }, new Date()),
  ).toContain("    Target output is not being recorded in /logs/live.");
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
        async listening() {
          return [];
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
test("status reports each Service's named ports, its automatic restarts and the Target's path routes", async () => {
  const routed = {
    ...target,
    plan: {
      domain: "demo.localhost",
      proxy: {
        upstream: "web",
        routes: [
          { prefix: "/api", service: "api", port: 4444 },
          { prefix: "/", service: "web", port: 4445 },
        ],
      },
      components: [
        { name: "api", kind: "managed", port: 4444, ports: { http: 4444 } },
        { name: "web", kind: "managed", port: 4445 },
      ],
    },
    services: {
      api: {
        deployment: "/w",
        intent: "running",
        attempts: [1, 2],
        unknownAttempts: [3],
      },
      web: { deployment: "/w", intent: "running", attempts: [] },
    },
  } as unknown as TargetRecord;
  const [report] = await observeTargets(
    [routed],
    {
      async process() {
        return { state: "running", pid: 22 };
      },
      async health() {
        return { ready: true };
      },
      async artifact() {
        return "installed";
      },
      async listening() {
        return [];
      },
      async persistent() {
        return true;
      },
    },
    1000,
    timerObservationDeadline,
  );
  expect(report!.routes).toEqual([
    { prefix: "/api", service: "api", port: 4444 },
    { prefix: "/", service: "web", port: 4445 },
  ]);
  expect(report!.components[0]).toMatchObject({
    name: "api",
    ports: { http: 4444 },
    restarts: 3,
  });
  expect(report!.components[1]).not.toHaveProperty("restarts");
  expect(report!.components[1]).not.toHaveProperty("ports");
});

test("a running Service judged by cached health or by nothing settles three microtasks after its process answers, so a deadline after that keeps its report", async () => {
  const cachedAndPlain = {
    ...target,
    plan: {
      components: [
        {
          name: "cached",
          kind: "managed",
          port: 4444,
          healthcheck: {
            interval: 30,
            timeout: 5,
            retries: 3,
            onFailure: "report",
          },
        },
        { name: "plain", kind: "managed", port: 4445 },
      ],
    },
  } as TargetRecord;
  // Expires the deadline `ticks` microtasks after both processes answer.
  const expiredAfter = async (ticks: number) => {
    const deadline = controlledDeadline();
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let started = 0;
    let bothStarted!: () => void;
    const bothWaiting = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const reports = observeTargets(
      [cachedAndPlain],
      {
        async process() {
          if (++started === 2) bothStarted();
          await answered;
          return { state: "running", pid: 22 };
        },
        async health() {
          throw new Error("a cached Service is never checked here");
        },
        async artifact() {
          return "installed";
        },
        async listening() {
          return [];
        },
        async persistent() {
          return true;
        },
      },
      100,
      deadline,
      () => ({ status: "healthy", failures: 0, retries: 3, restarts: 0 }),
    );
    // Count from when both observations wait on their process, however long they took to start.
    await bothWaiting;
    answer();
    for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
    deadline.expire();
    return (await reports)[0]!.components.map((c) => [c.name, c.state]);
  };
  expect(await expiredAfter(2)).toEqual([
    ["cached", "unknown"],
    ["plain", "unknown"],
  ]);
  expect(await expiredAfter(3)).toEqual([
    ["cached", "healthy"],
    ["plain", "running"],
  ]);
});

test("each Target gets back its own Components' reports in plan order, whatever order their observations complete in", async () => {
  const deadline = controlledDeadline();
  const managed = (name: string, port: number) => ({
    name,
    kind: "managed",
    port,
  });
  const recorded = (id: string, components: unknown[]) =>
    ({
      ...target,
      id,
      name: id,
      kind: "preview",
      plan: { components },
    }) as unknown as TargetRecord;
  const targets = [
    recorded("empty", []),
    recorded("three", [
      managed("api", 4000),
      { name: "cli", kind: "installed" },
      { name: "db", kind: "persistent" },
    ]),
    recorded("one", [managed("web", 4100)]),
    recorded("two", [managed("web", 4200), managed("worker", 4201)]),
  ];
  // Every process answers only once released, the last asked first; the Tool and the storage answer at once.
  const pending: (() => void)[] = [];
  const reports = observeTargets(
    targets,
    {
      process(target, component) {
        return new Promise((resolve) =>
          pending.push(() =>
            resolve({
              state: "running",
              pid: component.port! + (target.id === "two" ? 1 : 0),
            }),
          ),
        );
      },
      async health() {
        return { ready: true as const };
      },
      async artifact() {
        return "missing";
      },
      async listening() {
        return [];
      },
      async persistent() {
        return false;
      },
    },
    100,
    deadline,
  );
  while (pending.length < 4) await Promise.resolve();
  for (const release of pending.reverse()) {
    release();
    await Promise.resolve();
  }
  const observed = await reports;
  expect(observed.map((report) => [report.name, report.state])).toEqual([
    ["empty", "configured"],
    ["three", "degraded"],
    ["one", "running"],
    ["two", "running"],
  ]);
  expect(
    observed.map((report) =>
      report.components.map((c) => [c.name, c.state, c.pid]),
    ),
  ).toEqual([
    [],
    [
      ["api", "running", 4000],
      ["cli", "missing", undefined],
      ["db", "missing", undefined],
    ],
    [["web", "running", 4100]],
    [
      ["web", "running", 4201],
      ["worker", "running", 4202],
    ],
  ]);
  expect(deadline.pending).toBe(false);
});

test("componentBase carries a Service's ports, its recent automatic restarts and the hostnames reaching it, and only a Component's name and kind otherwise", () => {
  const plan = {
    domain: "demo.localhost",
    proxy: { upstream: "web" },
    components: [
      {
        name: "web",
        kind: "managed",
        port: 4445,
        ports: { http: 4445, admin: 4446 },
      },
      { name: "cli", kind: "installed" },
    ],
  };
  const recorded = {
    ...target,
    plan,
    services: { web: { attempts: [1], unknownAttempts: [2] } },
  } as unknown as TargetRecord;
  expect(componentBase(recorded, plan.components[0] as never)).toEqual({
    name: "web",
    kind: "managed",
    port: 4445,
    ports: { http: 4445, admin: 4446 },
    restarts: 2,
    route: "demo.localhost",
    hostnames: ["demo.localhost"],
  });
  expect(componentBase(recorded, plan.components[1] as never)).toEqual({
    name: "cli",
    kind: "installed",
  });
});

test("settledComponent keeps a completed report and makes one that failed or expired unknown, saying which", () => {
  const base = { name: "api", kind: "managed" as const, port: 4444 };
  const done = { ...base, state: "running" as const, pid: 1 };
  expect(settledComponent(base, { kind: "completed", value: done })).toBe(done);
  expect(settledComponent(base, { kind: "expired" })).toEqual({
    ...base,
    state: "unknown",
    reason: "Observation did not complete before the status deadline.",
  });
  expect(
    settledComponent(base, { kind: "rejected", error: new Error("private") }),
  ).toEqual({ ...base, state: "unknown", reason: "Observation failed." });
});

test("targetReport lists a Target's routes only under its domain, its Service domains, and its state from its Components", () => {
  const routed = {
    ...target,
    deploymentIncomplete: true,
    plan: {
      ...target.plan,
      proxy: { routes: [{ prefix: "/", service: "api", port: 4444 }] },
      serviceDomains: [
        { hostname: "api.demo.localhost", service: "api", port: 4444 },
      ],
    },
  } as unknown as TargetRecord;
  const healthy = [
    { name: "api", kind: "managed" as const, state: "healthy" as const },
  ];
  expect(targetReport(routed, healthy)).toEqual({
    id: "t",
    name: "stable",
    kind: "stable",
    branch: "main",
    commit: "abc",
    deploymentIncomplete: true,
    route: "demo.localhost",
    hostnames: ["demo.localhost", "api.demo.localhost"],
    routes: [{ prefix: "/", service: "api", port: 4444 }],
    serviceDomains: [
      { hostname: "api.demo.localhost", service: "api", port: 4444 },
    ],
    components: healthy,
    state: "healthy",
  });
  const undomained = {
    ...routed,
    plan: { ...routed.plan, domain: undefined, serviceDomains: undefined },
  } as unknown as TargetRecord;
  expect(targetReport(undomained, [])).not.toHaveProperty("routes");
  expect(targetReport(undomained, []).state).toBe("configured");
});
