import { expect, test } from "bun:test";
import {
  fileNamed,
  layeredKeys,
  own,
  readersOf,
  scopeFile,
  scopeKey,
  scopeReaders,
} from "../web/lib/env";
import { clientName } from "../web/server/guard";
import type { EnvFileView } from "../web/lib/types";

const file = (
  scope: EnvFileView["scope"],
  keys: string[],
  revision = "absent",
): EnvFileView => ({
  scope,
  path: `/rig/env/demo/${scopeFile(scope)}`,
  exists: keys.length > 0,
  revision,
  keys,
});

test("a scope's key names its file, and anything else names the Project's all.env", () => {
  const files = [
    {},
    { role: "stable" as const },
    { service: "web" },
    { service: "web", role: "preview" as const },
    { job: "db-backup", role: "working" as const },
  ].map((scope) => file(scope, []));
  for (const each of files)
    expect(fileNamed(files, scopeKey(each.scope))).toBe(each);
  for (const key of ["../x:all", "web:dev", undefined])
    expect(fileNamed(files, key)).toBe(files[0]!);
  expect(scopeFile({ service: "web", role: "stable" })).toBe("web/stable.env");
  expect(scopeFile({ job: "db-backup" })).toBe("db-backup/all.env");
  expect(scopeReaders({ role: "preview" })).toBe(
    "Read by every Service, Tool and Job of every Preview.",
  );
  expect(scopeReaders({ job: "db-backup", role: "stable" })).toBe(
    "Read by every run of the db-backup Job, and its restores, in the stable Target.",
  );
});

test("a Service or Job gets the Project's files, then its own, each for all roles and then its role, later files winning", () => {
  const files = [
    file({}, ["A", "B"], "r-all"),
    file({ role: "stable" }, ["B"], "r-stable"),
    file({ role: "working" }, ["W"]),
    file({ service: "web" }, ["C"], "r-web"),
    file({ service: "web", role: "stable" }, ["A"], "r-web-stable"),
    file({ service: "api", role: "stable" }, ["D"]),
    file({ job: "db-backup", role: "stable" }, ["B"], "r-job-stable"),
  ];
  expect(layeredKeys(files, "stable", { service: "web" })).toEqual([
    {
      key: "A",
      from: { service: "web", role: "stable" },
      revision: "r-web-stable",
      shadows: [{}],
    },
    { key: "B", from: { role: "stable" }, revision: "r-stable", shadows: [{}] },
    { key: "C", from: { service: "web" }, revision: "r-web", shadows: [] },
  ]);
  expect(layeredKeys(files, "stable", { job: "db-backup" })).toEqual([
    { key: "A", from: {}, revision: "r-all", shadows: [] },
    {
      key: "B",
      from: { job: "db-backup", role: "stable" },
      revision: "r-job-stable",
      shadows: [{}, { role: "stable" }],
    },
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
  // Each run and restore of a Job reads its files afresh, so no Target needs a restart.
  expect(readersOf({ job: "db-backup" }, targets)).toEqual([]);
});

test("Activity names where a signed-in browser's change came from, not a person, in plain words", () => {
  expect(clientName(null)).toBe("dashboard (this Mac)");
  expect(clientName("127.0.0.1")).toBe("dashboard (this Mac)");
  expect(clientName("100.64.1.2")).toBe("dashboard (100.64.1.2)");
  expect(clientName("100.64.1.2, 127.0.0.1")).toBe("dashboard (100.64.1.2)");
  expect(clientName("127.0.0.1, 100.64.1.2")).toBe("dashboard (100.64.1.2)");
  expect(clientName("fd7a::1<script>")).toBe("dashboard (fd7a::1c)");
});

test("own reads only a record's own entries, so names like constructor stay masked until revealed", () => {
  const revealed: Record<string, string> = {};
  expect(own(revealed, "constructor")).toBeUndefined();
  expect(own(revealed, "toString")).toBeUndefined();
  expect(
    own({ constructor: "v" } as Record<string, string>, "constructor"),
  ).toBe("v");
});
