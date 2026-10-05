import { expect, test } from "bun:test";
import {
  DEFAULT_STOP_TIMEOUT_SECONDS,
  serviceGraceMs,
  stopBudget,
} from "../src/domain/stop-budget";

test("every wait of a stop follows from the Service's grace, so rigd never ends the wrapper before the grace can finish", () => {
  const budget = stopBudget(120_000);
  expect(budget).toEqual({
    graceMs: 120_000,
    killWaitMs: 1500,
    // rigd waits for the wrapper: the grace, the wrapper's kill wait for its application, and headroom.
    wrapperMs: 123_500,
    killedWrapperMs: 5000,
  });
  expect(budget.wrapperMs).toBeGreaterThan(budget.graceMs + budget.killWaitMs);
});

test("the default grace is 10 s, and a plan recorded without one gets it", () => {
  expect(DEFAULT_STOP_TIMEOUT_SECONDS).toBe(10);
  expect(serviceGraceMs(undefined)).toBe(10_000);
  expect(serviceGraceMs(90)).toBe(90_000);
  expect(stopBudget(serviceGraceMs(undefined)).wrapperMs).toBe(13_500);
});

test("small test timings shrink every wait", () => {
  expect(stopBudget(200, { killWaitMs: 50, headroomMs: 50 })).toMatchObject({
    wrapperMs: 300,
    killedWrapperMs: 150,
  });
});
