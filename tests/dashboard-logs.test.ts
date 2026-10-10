import { expect, test } from "bun:test";
import {
  componentSlot,
  logComponentChoices,
  logFilter,
  logText,
  matchesSearch,
} from "../web/lib/logs";
import { logTargets } from "../web/server/logs";

const entry = (
  line: string,
  component = "web",
  stream = "stdout" as const,
) => ({
  timestamp: "2026-10-10T12:34:56.789Z",
  component,
  stream,
  line,
});

test("a Target's log components are its Services, then its Tools, then setup, as rigd accepts them", () => {
  expect(
    logComponentChoices([
      { name: "worker", kind: "managed" },
      { name: "cli", kind: "installed" },
      { name: "api", kind: "managed" },
      { name: "db", kind: "persistent" },
    ]),
  ).toEqual(["api", "worker", "cli", "setup"]);
});

test("the filter is left out when every line is wanted", () => {
  expect(logFilter({ services: [] })).toBeUndefined();
  expect(logFilter({ services: ["api"] })).toEqual({ services: ["api"] });
  expect(logFilter({ services: [], stream: "stderr" })).toEqual({
    stream: "stderr",
  });
});

test("the search matches every word in any case, in the line or its component", () => {
  expect(matchesSearch(entry("GET /healthz 200"), "")).toBe(true);
  expect(matchesSearch(entry("GET /healthz 200"), "get 200")).toBe(true);
  expect(matchesSearch(entry("GET /healthz 200"), "get 500")).toBe(false);
  expect(matchesSearch(entry("started", "worker"), "WORKER")).toBe(true);
});

test("a download reads as rig logs prints it", () => {
  expect(
    logText([entry("hello"), entry("boom", "api", "stderr" as never)]),
  ).toBe("12:34:56Z  web  > hello\n12:34:56Z  api  ! boom\n");
  expect(logText([])).toBe("");
});

test("each component keeps one colour", () => {
  expect(componentSlot("api")).toBe(componentSlot("api"));
  expect(componentSlot("api")).toBeGreaterThanOrEqual(0);
  expect(componentSlot("api")).toBeLessThan(6);
});

test("the log viewer lists Targets in page order with their components", () => {
  expect(
    logTargets([
      {
        name: "stable",
        kind: "stable",
        state: "running",
        components: [{ name: "web", kind: "managed", state: "running" }],
      },
      { name: "working", kind: "working", state: "stopped", components: [] },
    ]),
  ).toEqual([
    { name: "working", kind: "working", components: ["setup"] },
    { name: "stable", kind: "stable", components: ["web", "setup"] },
  ]);
});
