import { test, expect } from "bun:test";
import {
  createNoticeBoard,
  recordingDiagnostic,
  startFailureMonitor,
  DIAGNOSTIC_SINK,
  FAILURE_MONITOR,
} from "../src/daemon/notices";

const clock = () => {
  let tick = 0;
  return () => `2026-09-14T00:00:${String(tick++).padStart(2, "0")}Z`;
};

test("a diagnostic sink that returns or throws a failure never fails the caller; the board keeps one bounded entry per channel", async () => {
  const board = createNoticeBoard(clock());
  const entries: unknown[] = [];
  let mode: "ok" | "returned" | "thrown" = "ok";
  const diagnostic = recordingDiagnostic(
    {
      async record(entry) {
        entries.push(entry);
        if (mode === "thrown")
          throw new Error("EACCES: logs/rigd is not writable");
        return mode === "returned"
          ? { error: "Diagnostic evidence could not be recorded." }
          : { path: "/log" };
      },
    },
    board,
  );
  const event = {
    operationId: "op-1",
    action: "up",
    outcome: "started",
    errorCode: undefined,
  };
  await diagnostic(event);
  expect(board.list()).toEqual([]);
  expect(entries[0]).toMatchObject({
    event: "operation.completed",
    action: "up",
    outcome: "started",
  });
  mode = "returned";
  await diagnostic(event);
  mode = "thrown";
  for (let i = 0; i < 50; i++)
    await diagnostic({ ...event, errorCode: "X".repeat(1000) });
  expect(board.list()).toEqual([
    {
      channel: "diagnostics",
      count: 51,
      firstAt: "2026-09-14T00:00:00Z",
      lastAt: "2026-09-14T00:00:50Z",
      message:
        "Diagnostic evidence was not recorded: EACCES: logs/rigd is not writable",
      consequence: DIAGNOSTIC_SINK.consequence,
      hint: DIAGNOSTIC_SINK.hint,
    },
  ]);
  board.note(FAILURE_MONITOR, "m".repeat(1000));
  expect(board.list()).toHaveLength(2);
  expect(board.list()[1]!.message.length).toBeLessThanOrEqual(200);
  board.clear(FAILURE_MONITOR);
  expect(board.list().map((n) => n.channel)).toEqual(["diagnostics"]);
});

test("a failing monitor iteration is noted, never overlaps the next, and a later success clears the notice", async () => {
  const board = createNoticeBoard(clock());
  let calls = 0,
    active = 0,
    maxActive = 0,
    failing = true;
  let release: (() => void) | undefined;
  const stop = startFailureMonitor({
    intervalMs: 5,
    notices: board,
    async run() {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (release === undefined)
          await new Promise<void>((resolve) => (release = resolve));
        if (failing) throw new Error("state.json is locked");
        return { recorded: 0 };
      } finally {
        active--;
      }
    },
  });
  try {
    await Bun.sleep(40);
    expect(calls).toBe(1);
    release!();
    await Bun.sleep(40);
    expect(maxActive).toBe(1);
    const [notice] = board.list();
    expect(notice).toMatchObject({
      channel: "monitor",
      message: "The failure monitor's last pass failed: state.json is locked",
      hint: FAILURE_MONITOR.hint,
    });
    expect(notice!.count).toBeGreaterThanOrEqual(3);
    failing = false;
    await Bun.sleep(30);
    expect(board.list()).toEqual([]);
  } finally {
    stop();
  }
  const settled = calls;
  await Bun.sleep(30);
  expect(calls).toBe(settled);
});
