import { expect, test } from "bun:test";
import type { ManagedComponent } from "../src/config/types";
import type { ServiceHealth } from "../src/domain/project-status";
import type { ServiceRun, TargetRecord } from "../src/domain/runtime";
import {
  monitoredHealth,
  notRunningServiceReport,
  runningCommit,
  runningServiceReport,
} from "../src/runtime/service-report";

const web = (
  healthcheck?: ManagedComponent["healthcheck"],
): ManagedComponent => ({
  kind: "managed",
  name: "web",
  command: "serve",
  env: {},
  dependsOn: [],
  readyTimeout: 30,
  port: 4100,
  ...(healthcheck ? { healthcheck } : {}),
});
const check = (onFailure: "report" | "restart") => ({
  interval: 30,
  timeout: 5,
  retries: 3,
  onFailure,
});
const target = (run?: Partial<ServiceRun>, desired = "running") =>
  ({
    id: "t1",
    projectId: "p1",
    name: "stable",
    kind: "stable",
    desired,
    createdAt: "",
    updatedAt: "",
    logRoot: "/logs",
    plan: { workspacePath: "/w", components: [] },
    ...(run
      ? {
          services: {
            web: { deployment: "/w", intent: "running", attempts: [], ...run },
          },
        }
      : {}),
  }) as unknown as TargetRecord;
const base = { name: "web", kind: "managed" as const, port: 4100 };

test("an unknown process is reported unknown with its provider's reason, and without one when it gave none", () => {
  expect(
    notRunningServiceReport(target(), web(), base, {
      state: "unknown",
      reason: "launchd did not answer.",
    }),
  ).toEqual({ ...base, state: "unknown", reason: "launchd did not answer." });
  expect(
    notRunningServiceReport(target(), web(), base, { state: "unknown" }),
  ).toEqual({ ...base, state: "unknown" });
});

test("a stopped Service the operator stopped is stopped with a requested exit, its provider's reason first", () => {
  expect(
    notRunningServiceReport(target({ intent: "stopped" }), web(), base, {
      state: "stopped",
      reason: "Exit record unreadable.",
    }),
  ).toEqual({
    ...base,
    state: "stopped",
    exit: "requested",
    reason: "Exit record unreadable.",
  });
});

test("a stopped Service its health restart could not start again is unhealthy and waiting for the next restart", () => {
  const report = notRunningServiceReport(
    target({
      healthStretch: { since: 0, restarts: [60_000], pendingStart: 1 },
    }),
    web(check("restart")),
    base,
    { state: "stopped", reason: "Exit record unreadable." },
  );
  expect(report).toMatchObject({
    state: "unhealthy",
    health: { status: "unhealthy", restarts: 1, restartFailed: true },
  });
  expect(report.reason).toStartWith(
    "Exit record unreadable. Its health restart 1 did not leave it running",
  );
  // Under on_failure: report nothing waits for a health restart, so the restart policy decides.
  expect(
    notRunningServiceReport(
      target({ healthStretch: { since: 0, restarts: [], pendingStart: 1 } }),
      web(check("report")),
      base,
      { state: "stopped" },
    ).health,
  ).toBeUndefined();
});

test("a running Service reports its pid and health standing, its reasons joined in order and its Commit while the run names its process", () => {
  const kept = target({
    incarnation: "i1",
    source: { checkout: "/old", commit: "c-old", definition: "d" },
    restartedAfterUnknown: true,
  });
  const health: ServiceHealth = {
    status: "unhealthy",
    failures: 3,
    retries: 3,
    restarts: 0,
  };
  const report = runningServiceReport(
    kept,
    web(),
    base,
    { state: "running", pid: 7, incarnation: "i1", reason: "Output lost." },
    { state: "unhealthy", health, reason: "3 health checks in a row failed." },
  );
  expect(report).toEqual({
    ...base,
    pid: 7,
    commit: "c-old",
    state: "unhealthy",
    health,
    reason:
      "Output lost. Started again automatically after its previous process ended with nothing recorded about how (unknown exit, restarted). 3 health checks in a row failed.",
  });
  expect(Object.keys(report)).toEqual([
    "name",
    "kind",
    "port",
    "pid",
    "commit",
    "state",
    "health",
    "reason",
  ]);
  // Another process than the run names: no Commit and no note about the run.
  expect(
    runningServiceReport(
      kept,
      web(),
      base,
      { state: "running", pid: 8, incarnation: "i2" },
      { state: "running" },
    ),
  ).toEqual({ ...base, pid: 8, state: "running" });
});

test("runningCommit is the run's source Commit only while the observed process is the run's", () => {
  const kept = target({
    incarnation: "i1",
    source: { checkout: "/old", commit: "c-old", definition: "d" },
  });
  expect(runningCommit(kept, "web", { incarnation: "i1" })).toBe("c-old");
  expect(runningCommit(kept, "web", { incarnation: "i2" })).toBeUndefined();
  expect(runningCommit(kept, "web", {})).toBeUndefined();
  expect(runningCommit(target(), "web", { incarnation: "i1" })).toBeUndefined();
});

test("monitoredHealth leaves a Service without a healthcheck, or without a monitor, to be checked by its caller", () => {
  const results = () => undefined;
  expect(monitoredHealth(target(), web(), results)).toBeUndefined();
  expect(
    monitoredHealth(target(), web(check("report")), undefined),
  ).toBeUndefined();
});

test("monitoredHealth: running until a check answered, healthy with the failures so far, unhealthy with what Rig does", () => {
  const cached = (health?: ServiceHealth) => () => health;
  expect(
    monitoredHealth(target(), web(check("report")), cached(undefined)),
  ).toEqual({
    state: "running",
    health: { status: "starting", failures: 0, retries: 3, restarts: 0 },
    reason: "Its healthcheck has not answered since it started.",
  });
  expect(
    monitoredHealth(
      target(),
      web(check("report")),
      cached({ status: "healthy", failures: 0, retries: 3, restarts: 0 }),
    ),
  ).toEqual({
    state: "healthy",
    health: { status: "healthy", failures: 0, retries: 3, restarts: 0 },
  });
  expect(
    monitoredHealth(
      target(),
      web(check("report")),
      cached({
        status: "healthy",
        failures: 1,
        retries: 3,
        restarts: 0,
        output: "HTTP 503",
      }),
    )?.reason,
  ).toBe("1 health check in a row failed (HTTP 503); it is unhealthy after 3.");
  const unhealthy: ServiceHealth = {
    status: "unhealthy",
    failures: 3,
    retries: 3,
    restarts: 1,
  };
  expect(
    monitoredHealth(target(), web(check("restart")), cached(unhealthy)),
  ).toMatchObject({
    state: "unhealthy",
    reason:
      "3 health checks in a row failed. Rig restarts it (1 health restart so far).",
  });
  expect(
    monitoredHealth(
      target(),
      web(check("report")),
      cached({ ...unhealthy, failures: 0 }),
    )?.reason,
  ).toBe(
    "It became unhealthy, and no check has passed since. Its healthcheck's on_failure is report, so Rig reports it and does not restart it.",
  );
});
