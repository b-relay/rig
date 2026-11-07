import { expect, test } from "bun:test";
import type { ManagedComponent } from "../src/config/types";
import { RigError } from "../src/domain/errors";
import {
  DEFAULT_SUPERVISION_SCOPE,
  RESTART_BACKOFF_MS,
  RESTART_LIMIT,
  RESTART_WINDOW_MS,
  UNKNOWN_EXIT_RESTART_BACKOFF_MS,
  UNKNOWN_EXIT_RESTART_LIMIT,
  UNKNOWN_EXIT_RESTART_WINDOW_MS,
  cleanExit,
  failedAttempt,
  failedAttemptOutcome,
  failedStartRecorded,
  healthOwnsStart,
  inWindow,
  observedOutcome,
  recordKeepsStopped,
  restartBudget,
  scheduleAttempt,
  spentAttempts,
  stoppedByHostRestart,
  supervisionScope,
  withAttempts,
  withoutRetry,
} from "../src/domain/restart-policy";
import type { ServiceRun, TargetRecord } from "../src/domain/runtime";
import { untrackedRun } from "../src/runtime/service-runs";

const run = (fields: Partial<ServiceRun> = {}): ServiceRun => ({
  deployment: "/work",
  intent: "running",
  incarnation: "i1",
  attempts: [],
  ...fields,
});
const at = "2026-11-07T12:00:00.000Z";
const restarting = { onFailure: "restart" } as ManagedComponent["healthcheck"];
const pending = { since: 1, restarts: [2], pendingStart: 3 };

test("supervisionScope stops retrying unknown exits only while a Service carries a Host restart's outcome", () => {
  const target = (services: Record<string, ServiceRun>) =>
    ({
      plan: {
        workspacePath: "/work",
        components: [{ kind: "managed", name: "web" }],
      },
      services,
    }) as unknown as TargetRecord;
  expect(supervisionScope(target({}))).toBe(DEFAULT_SUPERVISION_SCOPE);
  expect(
    supervisionScope(
      target({
        web: run({ outcome: { kind: "unknown", hostRestart: "reboot", at } }),
      }),
    ),
  ).toEqual({ retryUnknownExits: false });
  // A record of another Deployment describes nothing.
  expect(
    supervisionScope(
      target({
        web: run({
          deployment: "/old",
          outcome: { kind: "unknown", hostRestart: "reboot", at },
        }),
      }),
    ),
  ).toEqual({ retryUnknownExits: true });
});

test("observedOutcome trusts only exit evidence that names the process Rig started", () => {
  expect(
    observedOutcome(
      run(),
      { state: "stopped", incarnation: "i1", exitCode: 3, recordedBy: "rigd" },
      at,
    ),
  ).toEqual({ kind: "exited", exitCode: 3, recordedBy: "rigd", at });
  expect(
    observedOutcome(
      run(),
      { state: "stopped", incarnation: "i1", signal: "SIGKILL" },
      at,
    ),
  ).toEqual({ kind: "exited", signal: "SIGKILL", at });
  for (const observation of [
    { state: "stopped", incarnation: "other", exitCode: 0 },
    { state: "stopped", incarnation: "i1" },
    { state: "stopped" },
  ] as const)
    expect(observedOutcome(run(), observation, at)).toEqual({
      kind: "unknown",
      at,
    });
  expect(
    observedOutcome(
      undefined,
      { state: "stopped", incarnation: "i1", exitCode: 0 },
      at,
    ),
  ).toEqual({ kind: "unknown", at });
});

test("cleanExit is code 0 with no signal", () => {
  expect(cleanExit({ kind: "exited", exitCode: 0, at })).toBe(true);
  expect(cleanExit({ kind: "exited", exitCode: 1, at })).toBe(false);
  expect(
    cleanExit({ kind: "exited", exitCode: 0, signal: "SIGTERM", at }),
  ).toBe(false);
  expect(cleanExit({ kind: "unknown", at })).toBe(false);
});

test("restartBudget keeps known and unknown exits on separate budgets", () => {
  const clean = { kind: "exited", exitCode: 0, at } as const;
  const crash = { kind: "exited", exitCode: 1, at } as const;
  const unknown = { kind: "unknown", at } as const;
  expect(restartBudget("always", clean)).toBe("known-exit");
  expect(restartBudget("on-failure", clean)).toBeUndefined();
  expect(restartBudget("on-failure", crash)).toBe("known-exit");
  expect(restartBudget("no", crash)).toBeUndefined();
  expect(restartBudget("always", unknown)).toBe("unknown-exit");
  expect(restartBudget("on-failure", unknown)).toBeUndefined();
  expect(
    restartBudget("always", unknown, { retryUnknownExits: false }),
  ).toBeUndefined();
  expect(
    restartBudget("always", { kind: "start-failed", errorCode: "X", at }),
  ).toBeUndefined();
  expect(
    restartBudget("on-failure", {
      kind: "activation-failed",
      errorCode: "X",
      at,
    }),
  ).toBe("known-exit");
});

test("spentAttempts and withAttempts read and replace one budget's attempts", () => {
  const record = run({ attempts: [1], unknownAttempts: [2] });
  expect(spentAttempts(record, "known-exit")).toEqual([1]);
  expect(spentAttempts(record, "unknown-exit")).toEqual([2]);
  expect(spentAttempts(run(), "unknown-exit")).toEqual([]);
  expect(withAttempts(record, "known-exit", [5])).toEqual(
    run({ attempts: [5], unknownAttempts: [2] }),
  );
  expect(withAttempts(record, "unknown-exit", [])).toEqual(
    run({ attempts: [1], unknownAttempts: [] }),
  );
});

test("scheduleAttempt drops attempts past the window, backs off, and is exhausted at the limit", () => {
  const ended = 1_000_000;
  expect(scheduleAttempt(run(), "known-exit", ended, [])).toEqual({
    run: run({ retryAt: ended + RESTART_BACKOFF_MS }),
  });
  // Two attempts, one past the window: one is kept and the delay doubles once.
  expect(
    scheduleAttempt(run({ attempts: [10, 20] }), "known-exit", ended, [
      RESTART_WINDOW_MS,
      5,
    ]),
  ).toEqual({ run: run({ attempts: [20], retryAt: ended + 200 }) });
  const full = Array.from({ length: RESTART_LIMIT }, (_, i) => i);
  expect(
    scheduleAttempt(
      run({ attempts: full }),
      "known-exit",
      ended,
      full.map(() => 0),
    ),
  ).toEqual({ exhausted: true });
  // The unknown-exit budget steps through its fixed delays, holding the last.
  expect(
    scheduleAttempt(
      run({ unknownAttempts: [1, 2] }),
      "unknown-exit",
      ended,
      [0, 0],
    ),
  ).toEqual({
    run: run({
      unknownAttempts: [1, 2],
      retryAt: ended + UNKNOWN_EXIT_RESTART_BACKOFF_MS[2],
    }),
  });
  const unknownFull = Array.from(
    { length: UNKNOWN_EXIT_RESTART_LIMIT },
    (_, i) => i,
  );
  expect(
    scheduleAttempt(
      run({ unknownAttempts: unknownFull }),
      "unknown-exit",
      ended,
      unknownFull.map(() => UNKNOWN_EXIT_RESTART_WINDOW_MS - 1),
    ),
  ).toEqual({ exhausted: true });
});

test("inWindow counts an attempt younger than its budget's window", () => {
  expect(inWindow("known-exit", RESTART_WINDOW_MS - 1)).toBe(true);
  expect(inWindow("known-exit", RESTART_WINDOW_MS)).toBe(false);
  expect(inWindow("unknown-exit", RESTART_WINDOW_MS)).toBe(true);
  expect(inWindow("unknown-exit", UNKNOWN_EXIT_RESTART_WINDOW_MS)).toBe(false);
});

test("withoutRetry drops the scheduled retry and the recorded wait, and nothing else", () => {
  expect(
    withoutRetry(
      run({ retryAt: 5, waitingFor: { service: "db" }, exhausted: true }),
    ),
  ).toEqual(run({ exhausted: true }));
  expect(withoutRetry(run())).toEqual(run());
});

test("healthOwnsStart hands a failed health start to the health monitor while its healthcheck restarts", () => {
  expect(
    healthOwnsStart(
      { healthcheck: restarting },
      run({ healthStretch: pending }),
    ),
  ).toBe(true);
  expect(
    healthOwnsStart(
      { healthcheck: { ...restarting!, onFailure: "report" } },
      run({ healthStretch: pending }),
    ),
  ).toBe(false);
  expect(healthOwnsStart({}, run({ healthStretch: pending }))).toBe(false);
  expect(
    healthOwnsStart(
      { healthcheck: restarting },
      run({ healthStretch: { since: 1, restarts: [] } }),
    ),
  ).toBe(false);
  // A Host restart stopped it since: restart policy and the Host restart rule decide again.
  expect(
    healthOwnsStart(
      { healthcheck: restarting },
      run({
        healthStretch: pending,
        outcome: { kind: "unknown", hostRestart: "login", at },
      }),
    ),
  ).toBe(false);
  expect(healthOwnsStart({ healthcheck: restarting }, undefined)).toBe(false);
});

test("stoppedByHostRestart replaces only an outcome that would still be acted on", () => {
  const always = { restart: "always" } as const;
  const no = { restart: "no" } as const;
  expect(stoppedByHostRestart(always, undefined)).toBe(true);
  expect(stoppedByHostRestart(always, run())).toBe(true);
  expect(
    stoppedByHostRestart(always, run({ outcome: { kind: "unknown", at } })),
  ).toBe(true);
  expect(
    stoppedByHostRestart(
      always,
      run({ outcome: { kind: "exited", exitCode: 1, at } }),
    ),
  ).toBe(true);
  // A clean exit under on-failure already keeps it stopped; under the default, always, it does not.
  expect(
    stoppedByHostRestart(
      { restart: "on-failure" },
      run({ outcome: { kind: "exited", exitCode: 0, at } }),
    ),
  ).toBe(false);
  expect(
    stoppedByHostRestart(
      {},
      run({ outcome: { kind: "exited", exitCode: 0, at } }),
    ),
  ).toBe(true);
  expect(
    stoppedByHostRestart(
      no,
      run({ outcome: { kind: "exited", exitCode: 1, at } }),
    ),
  ).toBe(false);
  // A health restart still to come would start it whatever the policy.
  expect(
    stoppedByHostRestart(
      no,
      run({
        outcome: { kind: "exited", exitCode: 1, at },
        healthStretch: pending,
      }),
    ),
  ).toBe(true);
  expect(stoppedByHostRestart(always, run({ intent: "stopped" }))).toBe(false);
  expect(stoppedByHostRestart(always, run({ exhausted: true }))).toBe(false);
});

test("failedStartRecorded skips an operator's stop and the same failure already recorded", () => {
  expect(failedStartRecorded(undefined, "X")).toBe(true);
  expect(failedStartRecorded(run(), "X")).toBe(true);
  expect(failedStartRecorded(run({ intent: "stopped" }), "X")).toBe(false);
  const failed = run({ outcome: { kind: "start-failed", errorCode: "X", at } });
  expect(failedStartRecorded(failed, "X")).toBe(false);
  expect(failedStartRecorded(failed, "Y")).toBe(true);
});

test("recordKeepsStopped is true for an outcome, an operator's stop, used-up attempts or a pending health start", () => {
  expect(recordKeepsStopped(undefined)).toBe(false);
  expect(recordKeepsStopped(run())).toBe(false);
  expect(recordKeepsStopped(run({ outcome: { kind: "unknown", at } }))).toBe(
    true,
  );
  expect(recordKeepsStopped(run({ exhausted: true }))).toBe(true);
  expect(recordKeepsStopped(run({ intent: "stopped" }))).toBe(true);
  expect(recordKeepsStopped(run({ healthStretch: pending }))).toBe(true);
  expect(
    recordKeepsStopped(run({ healthStretch: { since: 1, restarts: [] } })),
  ).toBe(false);
});

test("failedAttempt waits for a missing dependency only when nothing was spawned", () => {
  const dependency = new RigError("SERVICE_DEPENDENCY", "down", "", {
    dependency: "db",
  });
  const current = run({
    retryAt: 9,
    waitingFor: { ports: [1] },
    attempts: [1],
  });
  expect(
    failedAttempt(current, true, "known-exit", 50, dependency, at),
  ).toEqual({ waitingFor: { service: "db" } });
  // Spawned: the journal spent the attempt, so the record keeps its attempts.
  expect(
    failedAttempt(current, false, "known-exit", 50, dependency, at),
  ).toEqual({
    run: run({
      attempts: [1],
      outcome: {
        kind: "activation-failed",
        errorCode: "SERVICE_DEPENDENCY",
        at,
      },
    }),
  });
  // Refused before anything was spawned for another reason: the attempt is spent here.
  expect(
    failedAttempt(current, true, "unknown-exit", 50, new Error("boom"), at),
  ).toEqual({
    run: run({
      attempts: [1],
      unknownAttempts: [50],
      outcome: { kind: "activation-failed", errorCode: "UNEXPECTED", at },
    }),
  });
});

test("failedAttemptOutcome keeps the exit evidence a failed attempt carries, and only that", () => {
  expect(
    failedAttemptOutcome(
      new RigError("PROCESS_EXITED", "", "", {
        exitCode: 2,
        signal: "SIGTERM",
      }),
      at,
    ),
  ).toEqual({ kind: "exited", exitCode: 2, signal: "SIGTERM", at });
  expect(
    failedAttemptOutcome(new RigError("PROCESS_EXITED", "", ""), at),
  ).toEqual({ kind: "unknown", at });
  for (const code of ["START_ROLLBACK_FAILED", "START_UNVERIFIED"])
    expect(failedAttemptOutcome(new RigError(code, "", ""), at)).toEqual({
      kind: "unknown",
      at,
    });
  expect(failedAttemptOutcome(new RigError("PORT_BUSY", "", ""), at)).toEqual({
    kind: "activation-failed",
    errorCode: "PORT_BUSY",
    at,
  });
});

test("untrackedRun is the record of a Service nothing was recorded about yet", () => {
  expect(
    untrackedRun({ plan: { workspacePath: "/work" } } as TargetRecord),
  ).toEqual({ deployment: "/work", intent: "running", attempts: [] });
});
