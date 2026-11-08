import { expect, test } from "bun:test";
import { stopsWithin } from "../src/daemon/admin-stop";

test("a condition that ends is seen to end, asked once more after the wait", async () => {
  let asked = 0;
  expect(await stopsWithin(() => ++asked < 3, 5000)).toBe(true);
  // Twice while it held, once when it ended, and once more to decide.
  expect(asked).toBe(4);
});

test("a condition that holds past the budget is reported still holding", async () => {
  let asked = 0;
  expect(
    await stopsWithin(async () => {
      asked++;
      return true;
    }, 0),
  ).toBe(false);
  // Once before the deadline is checked, once at the end.
  expect(asked).toBe(2);
});
