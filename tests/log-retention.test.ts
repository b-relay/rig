import { expect, test } from "bun:test";
import { parseHostConfig } from "../src/config";
import { hostLogRetention } from "../src/daemon/log-retention";

test("the Host's log retention is re-read once the refresh interval has passed, and callers in between share one read", async () => {
  let clock = 0,
    reads = 0,
    logs: Record<string, number> = {};
  const retention = hostLogRetention({
    read: async () => {
      reads++;
      return parseHostConfig({ logs });
    },
    now: () => clock,
    refreshMs: 5000,
  });
  expect(await Promise.all([retention(), retention()])).toEqual([
    { maxBytes: 64 * 1024 * 1024, generations: 1 },
    { maxBytes: 64 * 1024 * 1024, generations: 1 },
  ]);
  expect(reads).toBe(1);
  logs = { max_bytes: 2 * 1024 * 1024, generations: 3 };
  clock = 4999;
  expect(await retention()).toEqual({
    maxBytes: 64 * 1024 * 1024,
    generations: 1,
  });
  clock = 5000;
  expect(await retention()).toEqual({
    maxBytes: 2 * 1024 * 1024,
    generations: 3,
  });
  expect(reads).toBe(2);
});

test("an unreadable or invalid Host config keeps the last retention that was read, so output is still recorded", async () => {
  let clock = 0,
    broken = false;
  const retention = hostLogRetention({
    read: async () => {
      if (broken) throw new Error("Invalid Host configuration.");
      return parseHostConfig({ logs: { generations: 4 } });
    },
    now: () => clock,
    refreshMs: 1000,
  });
  expect((await retention()).generations).toBe(4);
  broken = true;
  clock = 2000;
  expect((await retention()).generations).toBe(4);
  const fresh = hostLogRetention({
    read: async () => {
      throw new Error("Invalid Host configuration.");
    },
    now: () => 0,
    refreshMs: 1000,
  });
  expect(await fresh()).toEqual({
    maxBytes: 64 * 1024 * 1024,
    generations: 1,
  });
});
