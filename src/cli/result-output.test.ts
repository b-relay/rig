import { expect, test } from "bun:test";
import type { ProjectStatusReport } from "../domain/project-status";
import type { MonitorResult } from "../daemon/protocol";
import { resultOutput } from "./result-output";
import { monitorLines } from "./monitor-output";
import { renderResult, renderStatus } from "./output";

const unread = () => {
  throw new Error("the clock was read");
};
const status: ProjectStatusReport = {
  project: "pantry",
  targets: [
    {
      name: "stable",
      kind: "stable",
      state: "stopping",
      components: [
        {
          name: "web",
          kind: "managed",
          state: "stopping",
          killAt: "2026-09-27T04:31:00.000Z",
        },
      ],
    },
  ],
};
const monitor: MonitorResult = {
  project: "fletcher",
  since: 0,
  from: 0,
  to: 3600,
  step: 15,
  sampledEvery: 1,
  series: [],
};

test("--json prints a logs or activity read as JSON Lines, one record per line, and anything else as one document", () => {
  const view = { json: true, now: unread };
  expect(
    resultOutput("logs", { entries: [{ line: "a" }, { line: "b" }] }, view),
  ).toBe('{"line":"a"}\n{"line":"b"}\n');
  expect(
    resultOutput("activity", { operations: [{ id: "1" }], total: 9 }, view),
  ).toBe('{"id":"1"}\n');
  expect(resultOutput("status", status, { ...view, status })).toBe(
    `${JSON.stringify(status)}\n`,
  );
  expect(resultOutput("doctor", { ok: false, checks: [] }, view)).toBe(
    '{"ok":false,"checks":[]}\n',
  );
});

test("as text, a status report is read against the clock, Monitor as its table in the window it was given, and any other answer as the action's view", () => {
  const now = new Date("2026-09-27T04:20:00.000Z");
  expect(
    resultOutput("status", status, { json: false, status, now: () => now }),
  ).toBe(renderStatus(status, now));
  expect(
    resultOutput("monitor", monitor, {
      json: false,
      window: { since: "2h" },
      now: unread,
    }),
  ).toBe(`${monitorLines(monitor, { window: { since: "2h" } }).join("\n")}\n`);
  const up = { project: "pantry", target: "stable", outcome: "started" };
  expect(resultOutput("up", up, { json: false, now: unread })).toBe(
    renderResult("up", up),
  );
});
