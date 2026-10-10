import { expect, test } from "bun:test";
import {
  layeredKeys,
  parseScopeKey,
  readersOf,
  scopeFile,
  scopeKey,
  scopeReaders,
} from "../web/lib/env";
import { clientName } from "../web/server/guard";
import type { EnvFileView } from "../web/lib/types";

const file = (scope: EnvFileView["scope"], keys: string[]): EnvFileView => ({
  scope,
  path: `/rig/env/demo/${scopeFile(scope)}`,
  exists: keys.length > 0,
  revision: "absent",
  keys,
});

test("a scope round-trips through its key, and anything malformed names the Project's all.env", () => {
  for (const scope of [
    {},
    { role: "stable" as const },
    { service: "web" },
    { service: "web", role: "preview" as const },
  ])
    expect(parseScopeKey(scopeKey(scope))).toEqual(scope);
  expect(parseScopeKey("../x:all")).toEqual({});
  expect(parseScopeKey("web:dev")).toEqual({});
  expect(parseScopeKey(undefined)).toEqual({});
  expect(scopeFile({ service: "web", role: "stable" })).toBe("web/stable.env");
  expect(scopeReaders({ role: "preview" })).toBe(
    "Read by every Service and Tool of every Preview.",
  );
});

test("a Service gets the Project's files, then its own, each for all roles and then its role, later files winning", () => {
  const files = [
    file({}, ["A", "B"]),
    file({ role: "stable" }, ["B"]),
    file({ role: "working" }, ["W"]),
    file({ service: "web" }, ["C"]),
    file({ service: "web", role: "stable" }, ["A"]),
    file({ service: "api", role: "stable" }, ["D"]),
  ];
  expect(layeredKeys(files, "stable", "web")).toEqual([
    {
      key: "A",
      from: { service: "web", role: "stable" },
      shadows: [{}],
    },
    { key: "B", from: { role: "stable" }, shadows: [{}] },
    { key: "C", from: { service: "web" }, shadows: [] },
  ]);
  // A Tool gets the Project's files alone.
  expect(layeredKeys(files, "working").map((each) => each.key)).toEqual([
    "A",
    "B",
    "W",
  ]);
});

test("a file reaches the Targets of its role that run its Service", () => {
  const targets = [
    {
      name: "working",
      kind: "working" as const,
      state: "running" as const,
      components: [
        { name: "web", kind: "managed" as const, state: "running" as const },
      ],
    },
    {
      name: "stable",
      kind: "stable" as const,
      state: "running" as const,
      components: [
        { name: "api", kind: "managed" as const, state: "running" as const },
      ],
    },
  ];
  expect(readersOf({}, targets).map((each) => each.name)).toEqual([
    "working",
    "stable",
  ]);
  expect(
    readersOf({ role: "stable" }, targets).map((each) => each.name),
  ).toEqual(["stable"]);
  expect(
    readersOf({ service: "web" }, targets).map((each) => each.name),
  ).toEqual(["working"]);
});

test("Activity names the client a change came from, not a person, in plain words", () => {
  expect(clientName({ admitted: true, by: "session" }, "100.64.1.2")).toBe(
    "dashboard (signed in)",
  );
  expect(clientName({ admitted: true, by: "client" }, null)).toBe(
    "dashboard (this Mac)",
  );
  expect(clientName({ admitted: true, by: "client" }, "127.0.0.1")).toBe(
    "dashboard (this Mac)",
  );
  expect(
    clientName({ admitted: true, by: "client" }, "100.64.1.2, 127.0.0.1"),
  ).toBe("dashboard (100.64.1.2)");
  expect(clientName({ admitted: true, by: "client" }, "fd7a::1<script>")).toBe(
    "dashboard (fd7a::1c)",
  );
});
