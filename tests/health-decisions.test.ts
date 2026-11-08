import { expect, test } from "bun:test";
import type { ManagedComponent } from "../src/config/types";
import {
  NEW_HEALTH,
  checkIdentity,
  checkResult,
  healthPolicy,
  healthStartPending,
  identifiedHealthAction,
  judgedHealth,
  seededHealth,
  type HealthState,
} from "../src/domain/health-policy";
import {
  checkingHealth,
  droppedActivity,
  namedService,
  recoveredActivity,
  unhealthyActivity,
} from "../src/domain/health-wording";
import type { ServiceRun, TargetRecord } from "../src/domain/runtime";

const web = {
  kind: "managed",
  name: "web",
  health: "http://127.0.0.1:3000/health",
  healthcheck: { interval: 5, timeout: 2, retries: 3, onFailure: "restart" },
} as ManagedComponent;
const policy = healthPolicy(web)!;
const target = (run?: Partial<ServiceRun>) =>
  ({
    kind: "stable",
    name: "stable",
    plan: { project: "demo", workspacePath: "/work", components: [web] },
    services: run
      ? {
          web: {
            deployment: "/work",
            intent: "running",
            incarnation: "i1",
            attempts: [],
            ...run,
          },
        }
      : {},
  }) as unknown as TargetRecord;

test("healthPolicy reads the healthcheck in milliseconds, and nothing without one", () => {
  expect(policy).toEqual({
    intervalMs: 5000,
    timeoutMs: 2000,
    retries: 3,
    onFailure: "restart",
  });
  expect(healthPolicy({ ...web, healthcheck: undefined })).toBeUndefined();
});

test("healthStartPending is a failed health start a Host restart has not stopped since", () => {
  const stretch = { since: 1, restarts: [2], pendingStart: 3 };
  const run = (fields: Partial<ServiceRun>): ServiceRun => ({
    deployment: "/work",
    intent: "running",
    attempts: [],
    ...fields,
  });
  expect(healthStartPending(run({ healthStretch: stretch }))).toBe(true);
  expect(
    healthStartPending(run({ healthStretch: { since: 1, restarts: [2] } })),
  ).toBe(false);
  expect(
    healthStartPending(run({ healthStretch: stretch, intent: "stopped" })),
  ).toBe(false);
  expect(
    healthStartPending(
      run({
        healthStretch: stretch,
        outcome: { kind: "unknown", hostRestart: "reboot", at: "" },
      }),
    ),
  ).toBe(false);
  expect(healthStartPending(undefined)).toBe(false);
});

test("checkIdentity changes with the test, the policy, the directory and the ports", () => {
  const base = checkIdentity(web);
  expect(checkIdentity({ ...web })).toBe(base);
  expect(checkIdentity({ ...web, health: "http://127.0.0.1:3000/" })).not.toBe(
    base,
  );
  expect(
    checkIdentity({ ...web, healthcheck: { ...web.healthcheck!, retries: 1 } }),
  ).not.toBe(base);
  expect(checkIdentity({ ...web, workingDir: "app" })).not.toBe(base);
  expect(checkIdentity({ ...web, port: 3001 })).not.toBe(base);
});

test("identifiedHealthAction never restarts a process nothing identifies", () => {
  const unhealthy: HealthState = {
    incarnation: "i1",
    passed: false,
    failures: 3,
    stretch: { since: 1, restarts: [] },
  };
  expect(identifiedHealthAction(unhealthy, policy, 0)).toEqual({
    kind: "restart",
    attempt: 1,
  });
  const { incarnation: _unknown, ...adopted } = unhealthy;
  expect(identifiedHealthAction(adopted, policy, 0)).toEqual({ kind: "none" });
  // Waiting for the back-off says so whether or not the process is identified.
  const later = { ...adopted, stretch: { since: 1, restarts: [2] } };
  expect(identifiedHealthAction(later, policy, 0)).toEqual({
    kind: "wait",
    ms: 60_000,
  });
});

test("checkResult reads a probe answer, and no answer as a failure", () => {
  expect(checkResult(undefined, 2000)).toEqual({
    passed: false,
    output: "The check did not answer within 2s.",
  });
  expect(checkResult({ ready: true }, 2000)).toEqual({ passed: true });
  expect(checkResult({ ready: false, reason: "HTTP 503" }, 2000)).toEqual({
    passed: false,
    output: "HTTP 503",
  });
  expect(
    checkResult({ ready: false } as unknown as { ready: true }, 2000),
  ).toEqual({ passed: false, output: "failed" });
});

test("seededHealth starts afresh, carrying on the stretch the record continues", () => {
  expect(seededHealth(target(), "web")).toBe(NEW_HEALTH);
  expect(
    seededHealth(
      target({ healthStretch: { since: 1, restarts: [2], pendingStart: 3 } }),
      "web",
    ),
  ).toEqual({ failures: 0, stretch: { since: 1, restarts: [2] } });
});

test("judgedHealth keeps what is known of the same process and check, and starts afresh otherwise", () => {
  const known: HealthState = {
    incarnation: "i1",
    check: checkIdentity(web),
    failures: 1,
    stretch: { since: 1, restarts: [2] },
  };
  expect(judgedHealth(target({}), web, undefined)).toBe(NEW_HEALTH);
  expect(judgedHealth(target({}), web, known)).toBe(known);
  expect(judgedHealth(target({ incarnation: "i2" }), web, known)).toBe(
    NEW_HEALTH,
  );
  expect(
    judgedHealth(
      target({}),
      { ...web, health: "http://127.0.0.1:3000/" },
      known,
    ),
  ).toBe(NEW_HEALTH);
  // The record counted a health restart the cache could not.
  expect(
    judgedHealth(
      target({ healthStretch: { since: 1, restarts: [2, 3] } }),
      web,
      known,
    ),
  ).toEqual({ ...known, stretch: { since: 1, restarts: [2, 3] } });
  // A stretch the record says is pending although the process was seen running.
  const { stretch: _none, ...healthy } = known;
  expect(
    judgedHealth(
      target({ healthStretch: { since: 4, restarts: [5], pendingStart: 6 } }),
      web,
      healthy,
    ),
  ).toEqual({ ...healthy, stretch: { since: 4, restarts: [5] } });
  // Another stretch the cache already knows a different start of stays as cached.
  expect(
    judgedHealth(
      target({ healthStretch: { since: 9, restarts: [10, 11] } }),
      web,
      known,
    ),
  ).toBe(known);
});

test("health Activity says what changed and what Rig does about it", () => {
  const state: HealthState = {
    incarnation: "i1",
    failures: 3,
    output: "HTTP 503",
  };
  expect(unhealthyActivity("web", state, policy, target())).toEqual({
    action: "health",
    outcome: "failed",
    message:
      "web is unhealthy: 3 health checks in a row failed (HTTP 503). Rig restarts it.",
  });
  expect(
    unhealthyActivity("web", { failures: 1 }, { onFailure: "report" }, target())
      .message,
  ).toBe(
    "web is unhealthy: 1 health check in a row failed (no output). Its healthcheck's on_failure is report, so Rig only reports it.",
  );
  expect(
    unhealthyActivity("web", { failures: 1 }, policy, target()).message,
  ).toStartWith(
    "web is unhealthy: 1 health check in a row failed (no output). Rig cannot restart it for its health, since a rigd too old to record which process it is started it; run rig restart ",
  );
  expect(recoveredActivity("web")).toEqual({
    action: "health",
    outcome: "unchanged",
    message: "web is healthy again: its health check passed.",
  });
  expect(droppedActivity("web", 1).message).toBe(
    "web: 1 earlier change of health was not recorded, as Rig could not write its state.",
  );
  expect(droppedActivity("web", 2).message).toBe(
    "web: 2 earlier changes of health were not recorded, as Rig could not write its state.",
  );
  expect(namedService(target(), "web")).toBe("web on stable of demo");
  expect(checkingHealth(target(), "web")).toBe(
    "Checking the health of web on stable of demo",
  );
});
