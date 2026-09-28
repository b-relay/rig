import { expect, test } from "bun:test";
import { renderStatus } from "../src/cli/output";
import type { ManagedComponent } from "../src/config/types";
import type { ServiceHealth } from "../src/domain/project-status";
import type { TargetRecord } from "../src/domain/runtime";
import { stableTargetCondition } from "../src/runtime/alert-policy";
import { observeTargets, type ObservationEffects } from "../src/runtime/status";
import { controlledDeadline } from "./controlled-observation-deadline";

const component = (
  name: string,
  monitored: boolean,
  onFailure: "report" | "restart" = "report",
): ManagedComponent => ({
  kind: "managed",
  name,
  command: "serve",
  env: {},
  dependsOn: [],
  readyTimeout: 30,
  health: `http://127.0.0.1:4000/${name}`,
  ...(monitored
    ? {
        healthMonitor: { interval: 30, timeout: 5, failures: 3, onFailure },
      }
    : {}),
});
const live = (components: ManagedComponent[]) =>
  ({
    id: "t1",
    projectId: "p1",
    name: "live",
    kind: "live",
    desired: "running",
    createdAt: "",
    updatedAt: "",
    logRoot: "/logs",
    plan: {
      project: "demo",
      target: "live",
      workspacePath: "/work",
      dataRoot: "/data",
      deploymentName: "live",
      branchSlug: "live",
      subdomain: "live",
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

test("status reads a monitored Service's cached result and never runs its check; one without an interval is checked as before", async () => {
  const observed = effects();
  const target = live([
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
        checkedAt: "2026-09-28T10:00:00.000Z",
        failures: 0,
        threshold: 3,
        restarts: 0,
      },
      worker: {
        status: "unhealthy",
        checkedAt: "2026-09-28T10:00:00.000Z",
        failures: 2,
        threshold: 3,
        output: "exit code 1: heartbeat 93 s old",
        restarts: 0,
      },
    }),
  );
  expect(observed.checked).toEqual(["legacy"]);
  const byName = Object.fromEntries(report!.components.map((c) => [c.name, c]));
  expect(byName.web).toMatchObject({ state: "healthy" });
  expect(byName.worker).toMatchObject({
    state: "unhealthy",
    reason:
      "2 health checks in a row failed (exit code 1: heartbeat 93 s old); Rig acts after 3.",
  });
  expect(byName.fresh).toMatchObject({
    state: "running",
    health: { status: "pending" },
    reason: "Its ongoing health check has not answered since it started.",
  });
  expect(byName.legacy).toMatchObject({ state: "unhealthy" });
  expect(byName.legacy).not.toHaveProperty("health");

  // Without the monitor's results (as offline), a monitored Service is checked as before.
  const offline = effects();
  await observeTargets(
    [live([component("web", true)])],
    offline,
    2000,
    controlledDeadline(),
  );
  expect(offline.checked).toEqual(["web"]);
});

test("rig status shows the cached result: when it was checked, or failures of the threshold with the last output, and that Rig gave up", () => {
  const now = new Date("2026-09-28T10:00:12.000Z");
  const text = renderStatus(
    {
      project: "demo",
      targets: [
        {
          name: "live",
          kind: "live",
          state: "unhealthy",
          components: [
            {
              name: "web",
              kind: "managed",
              state: "healthy",
              health: {
                status: "healthy",
                checkedAt: "2026-09-28T10:00:00.000Z",
                failures: 0,
                threshold: 3,
                restarts: 0,
              },
            },
            {
              name: "scheduler",
              kind: "managed",
              state: "unhealthy",
              reason:
                "2 health checks in a row failed (HTTP 503); Rig acts after 3.",
              health: {
                status: "unhealthy",
                checkedAt: "2026-09-28T10:00:00.000Z",
                failures: 2,
                threshold: 3,
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
                failures: 9,
                threshold: 3,
                output: "exit code 1",
                restarts: 4,
                gaveUp: true,
              },
            },
          ],
        },
      ],
    },
    now,
  );
  expect(text).toContain("  web  healthy · checked 12s ago\n");
  expect(text).toContain("  scheduler  unhealthy 2/3 · HTTP 503\n");
  expect(text).toContain(
    "  worker  unhealthy 9/3 · exit code 1 · gave up restarting\n",
  );
  expect(text).toContain(
    "  live scheduler: 2 health checks in a row failed (HTTP 503); Rig acts after 3.",
  );
});

test("a Stable Target is down while a Service is marked unhealthy, not while its failures are still below the threshold", () => {
  const judged = (failures: number) =>
    stableTargetCondition({
      target: live([component("web", true)]),
      project: "demo",
      routes: "published",
      engaged: false,
      report: {
        name: "live",
        kind: "live",
        state: "unhealthy",
        components: [
          {
            name: "web",
            kind: "managed",
            state: "unhealthy",
            health: {
              status: "unhealthy",
              failures,
              threshold: 3,
              output: "HTTP 503",
              restarts: 0,
            },
          },
        ],
      },
    });
  expect(judged(2).state).toBe("up");
  expect(judged(3)).toMatchObject({
    state: "down",
    services: [{ name: "web", brief: "failing its health checks" }],
  });
});
