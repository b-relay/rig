import { expect, test } from "bun:test";
import { withPlanDefaults } from "../src/config/plan-defaults";
import { parseProjectConfig, resolveTargetPlan } from "../src/config";
import type { ManagedComponent, TargetPlan } from "../src/config";

const host = { operatorHome: "/home/operator", envRoot: "/rig/env" };
function planned(services: Record<string, Record<string, unknown>>) {
  return resolveTargetPlan(
    {
      config: parseProjectConfig({
        name: "demo",
        services,
        tools: { cli: { bin: "bin/cli" } },
      }),
      target: "local",
      workspacePath: "/work/demo",
      dataRoot: "/rig/data",
      assignedPorts: { "web.http": 4567 },
    },
    host,
  );
}
/** The plan as a rigd from before stop_timeout and restart recorded it. */
function recordedBefore(plan: TargetPlan): TargetPlan {
  const old = structuredClone(plan);
  for (const component of old.components)
    if (component.kind === "managed") {
      delete component.stopTimeout;
      delete component.restart;
    }
  return old;
}
const managed = (plan: TargetPlan, name: string) =>
  plan.components.find(
    (component): component is ManagedComponent =>
      component.kind === "managed" && component.name === name,
  )!;

test("a plan recorded before stop_timeout and restart existed reads as the plan the planner makes when config sets neither", () => {
  const current = planned({
    web: { run: "serve", ports: { http: "auto" } },
    worker: { run: "work" },
  });
  const old = recordedBefore(current);
  const before = structuredClone(old);
  expect(withPlanDefaults(old)).toStrictEqual(current);
  expect(managed(withPlanDefaults(old), "web")).toMatchObject({
    stopTimeout: 10,
    restart: "always",
  });
  // The recorded plan itself is left as it was recorded.
  expect(old).toStrictEqual(before);
});

test("values a plan recorded are kept, so a non-default stop_timeout or restart still differs from the default", () => {
  const current = planned({
    web: {
      run: "serve",
      ports: { http: "auto" },
      stop_timeout: "30s",
      restart: "no",
    },
  });
  expect(withPlanDefaults(current)).toStrictEqual(current);
  expect(withPlanDefaults(recordedBefore(current))).not.toEqual(current);
});

test("a plan with no managed Services, only Tools, is read unchanged", () => {
  const current = planned({});
  expect(current.components.map((c) => c.kind)).toEqual(["installed"]);
  expect(withPlanDefaults(current)).toStrictEqual(current);
});
