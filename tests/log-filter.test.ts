import { expect, test } from "bun:test";
import {
  matchesLogFilter,
  precedesLogWindow,
  type LogFilter,
} from "../src/domain/log-filter";
import { logTimeWindow } from "../src/cli/log-window";
import type { TargetLogEntry } from "../src/providers/contracts";

const entry = (overrides: Partial<TargetLogEntry> = {}): TargetLogEntry => ({
  timestamp: "2026-09-28T03:00:00.000Z",
  component: "web",
  stream: "stdout",
  line: "hello",
  ...overrides,
});

test("an empty filter keeps every entry, including unknown times and streams", () => {
  for (const value of [
    entry(),
    entry({ timestamp: "unknown", stream: "unknown" }),
    entry({ stream: "health" }),
  ])
    expect(matchesLogFilter(value, {})).toBe(true);
});

test("services keep only the named components", () => {
  const filter: LogFilter = { services: ["scheduler", "worker"] };
  expect(matchesLogFilter(entry({ component: "scheduler" }), filter)).toBe(
    true,
  );
  expect(matchesLogFilter(entry({ component: "worker" }), filter)).toBe(true);
  expect(matchesLogFilter(entry({ component: "web" }), filter)).toBe(false);
});

test("a stream keeps only that stream, never health or unknown evidence", () => {
  const filter: LogFilter = { stream: "stderr" };
  expect(matchesLogFilter(entry({ stream: "stderr" }), filter)).toBe(true);
  for (const stream of ["stdout", "health", "unknown"] as const)
    expect(matchesLogFilter(entry({ stream }), filter)).toBe(false);
});

test("since and until are inclusive bounds and leave out entries whose time is unknown", () => {
  const filter: LogFilter = {
    since: "2026-09-28T03:00:00.000Z",
    until: "2026-09-28T04:00:00.000Z",
  };
  expect(matchesLogFilter(entry(), filter)).toBe(true);
  expect(
    matchesLogFilter(entry({ timestamp: "2026-09-28T04:00:00Z" }), filter),
  ).toBe(true);
  expect(
    matchesLogFilter(entry({ timestamp: "2026-09-28T02:59:59.999Z" }), filter),
  ).toBe(false);
  expect(
    matchesLogFilter(entry({ timestamp: "2026-09-28T04:00:00.001Z" }), filter),
  ).toBe(false);
  expect(matchesLogFilter(entry({ timestamp: "unknown" }), filter)).toBe(false);
  expect(
    matchesLogFilter(entry({ timestamp: "unknown" }), {
      until: "2026-09-28T04:00:00.000Z",
    }),
  ).toBe(false);
});

test("an entry precedes the window only when its known time is before since", () => {
  const since = "2026-09-28T03:00:00.000Z";
  expect(
    precedesLogWindow(entry({ timestamp: "2026-09-28T02:00:00Z" }), { since }),
  ).toBe(true);
  expect(precedesLogWindow(entry(), { since })).toBe(false);
  expect(precedesLogWindow(entry({ timestamp: "unknown" }), { since })).toBe(
    false,
  );
  expect(
    precedesLogWindow(entry({ timestamp: "2000-01-01T00:00:00Z" }), {}),
  ).toBe(false);
});

const now = new Date("2026-09-28T12:00:00.000Z");

test("durations count back from now and ISO times keep their instant", () => {
  expect(logTimeWindow({ since: "1h" }, now)).toEqual({
    since: "2026-09-28T11:00:00.000Z",
  });
  expect(logTimeWindow({ since: "1h30m", until: "90s" }, now)).toEqual({
    since: "2026-09-28T10:30:00.000Z",
    until: "2026-09-28T11:58:30.000Z",
  });
  expect(logTimeWindow({ since: "2d" }, now).since).toBe(
    "2026-09-26T12:00:00.000Z",
  );
  expect(logTimeWindow({ since: "1w" }, now).since).toBe(
    "2026-09-21T12:00:00.000Z",
  );
  expect(logTimeWindow({ since: "2026-09-28T03:00:00+02:00" }, now)).toEqual({
    since: "2026-09-28T01:00:00.000Z",
  });
  expect(logTimeWindow({}, now)).toEqual({});
});

test("a time that is neither a duration nor an ISO time with a zone is a USAGE error naming the flag", () => {
  for (const value of [
    "yesterday",
    "1 h",
    "1y",
    "-5m",
    "2026-09-28T03:00:00",
    "2026-09-28",
    "",
  ]) {
    let error: unknown;
    try {
      logTimeWindow({ since: value }, now);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "USAGE" });
    expect((error as Error).message).toContain("--since");
    expect((error as { hint: string }).hint).toContain("2026-09-28T03:00:00Z");
  }
  expect(() => logTimeWindow({ until: "soon" }, now)).toThrow("--until");
  expect(() => logTimeWindow({ since: `${"9".repeat(20)}w` }, now)).toThrow(
    "--since",
  );
});

test("a since after until is a USAGE error", () => {
  expect(() => logTimeWindow({ since: "1h", until: "2h" }, now)).toThrow(
    expect.objectContaining({ code: "USAGE" }),
  );
  expect(logTimeWindow({ since: "1h", until: "1h" }, now)).toEqual({
    since: "2026-09-28T11:00:00.000Z",
    until: "2026-09-28T11:00:00.000Z",
  });
});
