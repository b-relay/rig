import { expect, test } from "bun:test";
import { renderStatus } from "../src/cli/output";
import type { ManagedComponent } from "../src/config/types";
import {
  healthSummary,
  type ServiceHealth,
} from "../src/domain/project-status";
import type { TargetRecord } from "../src/domain/runtime";
import { observeTargets, type ObservationEffects } from "../src/runtime/status";
import { controlledDeadline } from "./controlled-observation-deadline";

const component = (
  name: string,
  checked: boolean,
  onFailure: "report" | "restart" = "report",
): ManagedComponent => ({
  kind: "managed",
  name,
  command: "serve",
  env: {},
  dependsOn: [],
  readyTimeout: 30,
  health: `http://127.0.0.1:4000/${name}`,
  ...(checked
    ? { healthcheck: { interval: 30, timeout: 5, retries: 3, onFailure } }
    : {}),
});
const stable = (components: ManagedComponent[]) =>
  ({
    id: "t1",
    projectId: "p1",
    name: "stable",
    kind: "stable",
    desired: "running",
    createdAt: "",
    updatedAt: "",
    logRoot: "/logs",
    plan: {
      project: "demo",
      target: "stable",
      workspacePath: "/work",
      dataRoot: "/data",
      deploymentName: "stable",
      branchSlug: "stable",
      subdomain: "stable",
      providers: { processSupervisor: "rigd" },
      components,
      preparedComponents: [],
    },
  }) as unknown as TargetRecord;

function effects(): ObservationEffects & { checked: string[] } {
  const checked: string[] = [];
  return {
    checked,
    async process() {
      return { state: "running", pid: 7 };
    },
    async health(_target, component) {
      checked.push(component.name);
      return { ready: false, reason: "HTTP 500" };
    },
    async artifact() {
      return "installed";
    },
    async persistent() {
      return true;
    },
    async listening() {
      return [];
    },
  };
}
const results =
  (cached: Record<string, ServiceHealth>) =>
  (_target: { id: string }, service: string) =>
    cached[service];

test("status reads a Service's cached healthcheck result and never runs its check; a plan from before healthcheck is checked as before", async () => {
  const observed = effects();
  const target = stable([
    component("web", true),
    component("worker", true, "restart"),
    component("fresh", true),
    component("legacy", false),
  ]);
  const [report] = await observeTargets(
    [target],
    observed,
    2000,
    controlledDeadline(),
    results({
      web: {
        status: "healthy",
        checkedAt: "2026-10-05T10:00:00.000Z",
        failures: 0,
        retries: 3,
        restarts: 0,
      },
      worker: {
        status: "unhealthy",
        checkedAt: "2026-10-05T10:00:00.000Z",
        failures: 3,
        retries: 3,
        output: "exit code 1: heartbeat 93s old",
        restarts: 2,
      },
    }),
  );
  expect(observed.checked).toEqual(["legacy"]);
  const byName = Object.fromEntries(report!.components.map((c) => [c.name, c]));
  expect(byName.web).toMatchObject({ state: "healthy" });
  expect(byName.worker).toMatchObject({
    state: "unhealthy",
    reason:
      "3 health checks in a row failed (exit code 1: heartbeat 93s old). Rig restarts it (2 health restarts so far).",
  });
  expect(byName.fresh).toMatchObject({
    state: "running",
    health: { status: "starting" },
    reason: "Its healthcheck has not answered since it started.",
  });
  expect(byName.legacy).toMatchObject({ state: "unhealthy" });
  expect(byName.legacy).not.toHaveProperty("health");

  // Without the monitor's results (no rigd monitor runs), a Service with a healthcheck is checked once here.
  const offline = effects();
  await observeTargets(
    [stable([component("web", true)])],
    offline,
    2000,
    controlledDeadline(),
  );
  expect(offline.checked).toEqual(["web"]);
});

test("rig status shows the cached result: when it last passed, or failures of retries with the last output and the restart count", () => {
  const now = new Date("2026-10-05T10:00:12.000Z");
  const text = renderStatus(
    {
      project: "demo",
      targets: [
        {
          name: "stable",
          kind: "stable",
          state: "unhealthy",
          components: [
            {
              name: "web",
              kind: "managed",
              state: "healthy",
              health: {
                status: "healthy",
                checkedAt: "2026-10-05T10:00:00.000Z",
                failures: 0,
                retries: 3,
                restarts: 0,
              },
            },
            {
              name: "api",
              kind: "managed",
              state: "unhealthy",
              reason:
                "3 health checks in a row failed (HTTP 503). Its healthcheck's on_failure is report, so Rig reports it and does not restart it.",
              health: {
                status: "unhealthy",
                checkedAt: "2026-10-05T10:00:00.000Z",
                failures: 3,
                retries: 3,
                output: "HTTP 503",
                restarts: 0,
              },
            },
            {
              name: "worker",
              kind: "managed",
              state: "unhealthy",
              health: {
                status: "unhealthy",
                failures: 0,
                retries: 3,
                output: "exit code 1",
                restarts: 1,
              },
            },
            {
              name: "queue",
              kind: "managed",
              state: "healthy",
              reason:
                "1 health check in a row failed (HTTP 502); it is unhealthy after 3.",
              health: {
                status: "healthy",
                checkedAt: "2026-10-05T09:58:00.000Z",
                failures: 1,
                retries: 3,
                output: "HTTP 502",
                restarts: 0,
              },
            },
          ],
        },
      ],
    },
    now,
  );
  expect(text).toContain("  web  healthy · checked 12s ago\n");
  expect(text).toContain("  api  unhealthy 3/3 · HTTP 503\n");
  expect(text).toContain(
    "  worker  unhealthy · exit code 1 · restarted 1 time\n",
  );
  expect(text).toContain("  queue  healthy · 1/3 failed · checked 2m ago\n");
  expect(text).toContain(
    "  stable api: 3 health checks in a row failed (HTTP 503). Its healthcheck's on_failure is report, so Rig reports it and does not restart it.",
  );
});

test("a Service without a cached result, or in another state, has no health summary", () => {
  const now = new Date();
  expect(healthSummary({ state: "running" }, now)).toBeUndefined();
  expect(
    healthSummary(
      {
        state: "running",
        health: { status: "starting", failures: 0, retries: 3, restarts: 0 },
      },
      now,
    ),
  ).toBeUndefined();
});
