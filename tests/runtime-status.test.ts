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
    result.flatMap((t) => t.components).every((c) =>
      c.state === "unknown" &&
      c.reason === "Observation did not complete before the status deadline."
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
  const [report] = await observeTargets(
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
  );
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
        return true;
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
    },
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
