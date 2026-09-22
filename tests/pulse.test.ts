import { expect, test } from "bun:test";
import { pulseStamp, type PulseReadings } from "../web/lib/pulse";

const readings = (over: Partial<PulseReadings> = {}): PulseReadings => ({
  health: {
    ok: true,
    value: { instanceId: "i-1", pid: 42, running: true, version: "0.1.0" },
  },
  queue: { ok: true, value: { waiting: 0 } },
  activity: {
    ok: true,
    value: {
      operations: [
        {
          id: "a",
          action: "up",
          outcome: "succeeded",
          occurredAt: "2026-09-22T10:00:00Z",
        },
        {
          id: "b",
          action: "deploy",
          outcome: "succeeded",
          occurredAt: "2026-09-22T11:00:00Z",
        },
      ],
    },
  },
  ...over,
});

test("the stamp holds still while nothing rigd records has changed", () => {
  expect(pulseStamp(readings())).toEqual(pulseStamp(readings()));
  expect(pulseStamp(readings()).busy).toBe(false);
});

test("a new Operation, a restarted rigd, or a running Operation each change the stamp", () => {
  const quiet = pulseStamp(readings()).stamp;
  const recorded = readings({
    activity: {
      ok: true,
      value: {
        operations: [
          {
            id: "c",
            action: "down",
            outcome: "failed",
            occurredAt: "2026-09-22T12:00:00Z",
          },
        ],
      },
    },
  });
  expect(pulseStamp(recorded).stamp).not.toBe(quiet);
  const restarted = readings({
    health: { ok: true, value: { instanceId: "i-2", pid: 43, running: true } },
  });
  expect(pulseStamp(restarted).stamp).not.toBe(quiet);
  const running = pulseStamp(
    readings({
      queue: {
        ok: true,
        value: {
          waiting: 1,
          running: {
            operationId: "op",
            action: "deploy",
            startedAt: "2026-09-22T12:00:00Z",
          },
        },
      },
    }),
  );
  expect(running.stamp).not.toBe(quiet);
  expect(running.busy).toBe(true);
});

test("rigd being unreachable is a stamp of its own, so the page redraws once it is back", () => {
  const down = pulseStamp(
    readings({
      health: { ok: false, failure: { code: "DAEMON_DOWN", message: "no" } },
      queue: { ok: false, failure: { code: "DAEMON_DOWN", message: "no" } },
      activity: { ok: false, failure: { code: "DAEMON_DOWN", message: "no" } },
    }),
  );
  expect(down.stamp).toBe("down:DAEMON_DOWN|?|?");
  expect(down.busy).toBe(false);
});
