import { expect, test } from "bun:test";
import {
  configJsonSchemas,
  parseProjectConfig,
  resolveTargetPlan,
} from "../src/config/index.js";
import type { ManagedComponent } from "../src/config/types";

const RESOLVE_HOST = { operatorHome: "/home/operator", envRoot: "/rig/env" };
const project = (health: Record<string, unknown>, targets?: unknown) => ({
  format: "rig/v2",
  name: "app",
  services: { web: { run: "serve", ports: { http: 4000 }, health } },
  ...(targets ? { targets } : {}),
});
const hintOf = (value: unknown) => {
  try {
    parseProjectConfig(value);
  } catch (error) {
    return (error as { hint: string }).hint;
  }
  return "";
};
const web = (config: unknown, target: "local" | "live" | "preview" = "live") =>
  resolveTargetPlan(
    {
      config: parseProjectConfig(config),
      target,
      workspacePath: "/work",
      dataRoot: "/data",
      branch: "feature",
      assignedPorts: { "web.http": 4000 },
    },
    RESOLVE_HOST,
  ).components.find(
    (component): component is ManagedComponent => component.name === "web",
  )!;
const CHECK = "http://127.0.0.1:${services.web.ports.http}/healthz";

test("health.interval turns on ongoing checks with their defaults; without it the plan is what it was", () => {
  expect(web(project({ check: CHECK, interval: "30s" }))).toMatchObject({
    health: "http://127.0.0.1:4000/healthz",
    readyTimeout: 30,
    healthMonitor: {
      interval: 30,
      timeout: 5,
      failures: 3,
      onFailure: "report",
    },
  });
  expect(
    web(
      project({
        check: CHECK,
        start_timeout: "1m",
        interval: "10s",
        timeout: "2s",
        failures: 5,
        on_failure: "restart",
        retry_for: "6h",
      }),
    ).healthMonitor,
  ).toEqual({
    interval: 10,
    timeout: 2,
    failures: 5,
    onFailure: "restart",
    retryFor: 21600,
  });
  const startOnly = web(project({ check: CHECK }));
  expect(startOnly).not.toHaveProperty("healthMonitor");
  expect(startOnly.health).toBe("http://127.0.0.1:4000/healthz");
});

test("every health field is patchable per role; a role patch changes only that role's Targets", () => {
  const config = project(
    { check: CHECK, interval: "30s" },
    {
      stable: {
        services: {
          web: { health: { on_failure: "restart", retry_for: "6h" } },
        },
      },
      preview: { services: { web: { health: { interval: "1m" } } } },
    },
  );
  expect(web(config, "live").healthMonitor).toMatchObject({
    interval: 30,
    onFailure: "restart",
    retryFor: 21600,
  });
  expect(web(config, "local").healthMonitor).toMatchObject({
    interval: 30,
    onFailure: "report",
  });
  expect(web(config, "preview").healthMonitor).toMatchObject({
    interval: 60,
    onFailure: "report",
  });
  // A role can turn ongoing checks on for itself only.
  const stableOnly = project(
    { check: CHECK },
    { stable: { services: { web: { health: { interval: "15s" } } } } },
  );
  expect(web(stableOnly, "live").healthMonitor?.interval).toBe(15);
  expect(web(stableOnly, "local")).not.toHaveProperty("healthMonitor");
});

test("ongoing check settings are refused where they cannot act, with the reason", () => {
  expect(hintOf(project({ check: CHECK, interval: "4s" }))).toBe(
    "Fix services.web.health.interval: must be at least 5s.",
  );
  expect(hintOf(project({ interval: "30s" }))).toBe(
    "Fix services.web.health.interval: health.interval of Service 'web' needs health.check: ongoing checks run it.",
  );
  expect(hintOf(project({ check: CHECK, on_failure: "restart" }))).toBe(
    "Fix services.web.health.on_failure: health.on_failure of Service 'web' needs health.interval; without it the check runs only at start.",
  );
  expect(
    hintOf(project({ check: CHECK, interval: "30s", retry_for: "6h" })),
  ).toBe(
    "Fix services.web.health.retry_for: health.retry_for of Service 'web' applies only with health.on_failure: restart.",
  );
  expect(hintOf(project({ check: CHECK, interval: "30s", failures: 0 }))).toBe(
    "Fix services.web.health.failures: must be at least 1.",
  );
  expect(
    hintOf(project({ check: CHECK, interval: "30s", on_failure: "page" })),
  ).toBe(
    'Fix services.web.health.on_failure: must be one of "report", "restart".',
  );
  // Checked after a role's patch is applied, and reported at the patch.
  expect(
    hintOf(
      project(
        { check: CHECK },
        { stable: { services: { web: { health: { failures: 2 } } } } },
      ),
    ),
  ).toBe(
    "Fix targets.stable.services.web.health.failures: health.failures of Service 'web' needs health.interval; without it the check runs only at start.",
  );
  expect(
    hintOf(
      project({
        check: CHECK,
        interval: "30s",
        on_failure: "restart",
        retry_for: "721h",
      }),
    ),
  ).toBe(
    "Fix services.web.health.retry_for: must be a positive duration of at most 720h (30 days), such as 6h.",
  );
});

test("the JSON Schema documents every health field and the defaults planning applies", () => {
  const schema = configJsonSchemas()["rig.schema.json"] as Record<string, any>;
  const health =
    schema.properties.services.additionalProperties.properties.health;
  for (const field of [
    "check",
    "start_timeout",
    "interval",
    "timeout",
    "failures",
    "on_failure",
    "retry_for",
  ])
    expect(health.properties[field].description).toBeString();
  expect(health.properties).toMatchObject({
    timeout: { default: "5s" },
    failures: { default: 3 },
    on_failure: { default: "report", enum: ["report", "restart"] },
  });
  expect(health.properties.interval.default).toBeUndefined();
  expect(health.properties.retry_for.default).toBeUndefined();
});

test("the guide's heartbeat check for a worker without a port is a valid ongoing check", () => {
  const worker = resolveTargetPlan(
    {
      config: parseProjectConfig({
        format: "rig/v2",
        name: "app",
        services: {
          scheduler: {
            run: "bun run src/scheduler.ts",
            env: { STATE: "${rig.data}" },
            health: {
              check:
                'test $(( $(date +%s) - $(stat -f %m "$STATE/heartbeat") )) -lt 60',
              interval: "30s",
              on_failure: "restart",
            },
          },
        },
      }),
      target: "live",
      workspacePath: "/work",
      dataRoot: "/data",
    },
    RESOLVE_HOST,
  ).components[0] as ManagedComponent;
  expect(worker).toMatchObject({
    health: 'test $(( $(date +%s) - $(stat -f %m "$STATE/heartbeat") )) -lt 60',
    env: { STATE: "/data/scheduler" },
    healthMonitor: { interval: 30, onFailure: "restart" },
  });
});
