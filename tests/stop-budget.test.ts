import { expect, test } from "bun:test";
import {
  DEFAULT_STOP_TIMEOUT_SECONDS,
  serviceGraceMs,
  stopBudget,
} from "../src/domain/stop-budget";

test("every wait of a stop follows from the Service's grace, so no outer layer ends the wrapper before the grace can finish", () => {
  const budget = stopBudget(120_000);
  expect(budget).toEqual({
    graceMs: 120_000,
    killWaitMs: 1500,
    // rigd waits for the wrapper: the grace, the wrapper's kill wait for its application, and headroom.
    wrapperMs: 123_500,
    killedWrapperMs: 5000,
    // launchd's ExitTimeOut covers the same, rounded up to whole seconds.
    exitTimeOutSeconds: 124,
    // The unload wait outlasts ExitTimeOut by launchd's own kill wait and headroom.
    unloadMs: 127_500,
  });
  expect(budget.wrapperMs).toBeGreaterThan(budget.graceMs + budget.killWaitMs);
  expect(budget.exitTimeOutSeconds * 1000).toBeGreaterThanOrEqual(
    budget.wrapperMs,
  );
  expect(budget.unloadMs).toBeGreaterThan(budget.exitTimeOutSeconds * 1000);
});

test("the default grace is 10 s, and a plan recorded without one gets it", () => {
  expect(DEFAULT_STOP_TIMEOUT_SECONDS).toBe(10);
  expect(serviceGraceMs(undefined)).toBe(10_000);
  expect(serviceGraceMs(90)).toBe(90_000);
  expect(stopBudget(serviceGraceMs(undefined)).exitTimeOutSeconds).toBe(14);
});

test("small test timings keep ExitTimeOut at least one second, since launchd reads 0 as forever", () => {
  expect(
    stopBudget(0, { killWaitMs: 0, headroomMs: 0 }).exitTimeOutSeconds,
  ).toBe(1);
  expect(stopBudget(200, { killWaitMs: 50, headroomMs: 50 })).toMatchObject({
    wrapperMs: 300,
    killedWrapperMs: 150,
    exitTimeOutSeconds: 1,
    unloadMs: 1100,
  });
});
