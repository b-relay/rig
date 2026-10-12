import { expect, test } from "bun:test";
import { runRigCli } from "../src/cli/rig";
import type { ProjectStatusReport } from "../src/domain/project-status";

/** rig against a fake rigd that answers every command with `reply`, recording each request and what went to stdout and
 * stderr apart. */
function cli(reply: (request: Record<string, unknown>) => unknown) {
  const requests: Record<string, unknown>[] = [];
  const out = { stdout: "", stderr: "" };
  const dependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command(request: unknown) {
        const { operationId: _, ...rest } = request as Record<string, unknown>;
        requests.push(rest);
        return reply(rest);
      },
    },
    output: {
      write(value: string) {
        out.stdout += value;
      },
      error(value: string) {
        out.stderr += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "op-1",
    now: () => new Date("2026-10-12T12:00:00Z"),
  };
  return {
    requests,
    out,
    run: (args: string[]) => runRigCli(args, dependencies),
  };
}
const record = (id: string) => ({
  id,
  project: "pantry",
  target: "stable",
  action: "deploy",
  outcome: "deployed",
  occurredAt: "2026-10-12T11:00:00.000Z",
});

test("rig activity reads this Project's newest 20 records; --all reads the Host; the filters travel to rigd", async () => {
  const f = cli(() => ({ operations: [] }));
  expect(await f.run(["activity"])).toBe(0);
  expect(await f.run(["activity", "--all", "--lines", "5"])).toBe(0);
  expect(
    await f.run([
      "activity",
      "--project",
      "pantry",
      "--target",
      "stable",
      "--action",
      "deploy",
      "--outcome",
      "failed",
      "--since",
      "1d",
    ]),
  ).toBe(0);
  expect(await f.run(["activity", "3f2a"])).toBe(0);
  expect(f.requests).toEqual([
    { action: "activity", repoPath: "/workspace", lines: 20 },
    { action: "activity", repoPath: "/workspace", host: true, lines: 5 },
    {
      action: "activity",
      repoPath: "/workspace",
      project: "pantry",
      lines: 20,
      activityFilter: {
        target: "stable",
        action: "deploy",
        outcome: "failed",
        since: "2026-10-11T12:00:00.000Z",
      },
    },
    { action: "activity", repoPath: "/workspace", operation: "3f2a" },
  ]);
});

test("rig activity refuses what cannot be read together, and more records than rigd keeps, before asking rigd", async () => {
  const f = cli(() => ({ operations: [] }));
  for (const args of [
    ["activity", "--all", "--project", "pantry"],
    ["activity", "3f2a", "--outcome", "failed"],
    ["activity", "--lines", "1001"],
    ["activity", "--outcome", "sideways"],
  ])
    expect(await f.run(args)).toBe(1);
  expect(f.requests).toEqual([]);
});

test("rig activity --json prints one record per line, and says on stderr how many it left out", async () => {
  const f = cli(() => ({
    operations: [record("a"), record("b")],
    total: 340,
  }));
  expect(await f.run(["activity", "--json", "--lines", "2"])).toBe(0);
  expect(f.out.stdout.split("\n")).toEqual([
    JSON.stringify(record("a")),
    JSON.stringify(record("b")),
    "",
  ]);
  expect(f.out.stderr).toBe("showing 2 of 340 records; --lines to see more\n");
});

test("nothing is said on stderr when every matching record is shown", async () => {
  const f = cli(() => ({ operations: [record("a")], total: 1 }));
  expect(await f.run(["activity"])).toBe(0);
  expect(f.out.stderr).toBe("");
});

const long = "x".repeat(2500);
const entry = (line: string) => ({
  timestamp: "2026-10-12T11:00:00.000Z",
  component: "web",
  stream: "stdout",
  line,
});

test("rig logs shortens a line past 2,000 characters, saying how much it left out; --full prints it whole", async () => {
  const f = cli(() => ({
    project: "pantry",
    target: "working",
    entries: [entry("short"), entry(long)],
    cursor: "c",
  }));
  expect(await f.run(["logs"])).toBe(0);
  expect(f.out.stdout).toContain("> short\n");
  expect(f.out.stdout).toContain(
    `> ${"x".repeat(2000)} … (500 more characters)\n`,
  );
  f.out.stdout = "";
  expect(await f.run(["logs", "--full"])).toBe(0);
  expect(f.out.stdout).toContain(`> ${long}\n`);
});

test("rig logs --json prints one entry per line, a shortened one with the characters it left out", async () => {
  const f = cli(() => ({
    project: "pantry",
    target: "working",
    entries: [entry("short"), entry(long)],
    cursor: "c",
    more: true,
  }));
  expect(await f.run(["logs", "--json", "--lines", "2"])).toBe(0);
  expect(
    f.out.stdout.split("\n").map((line) => line && JSON.parse(line)),
  ).toEqual([entry("short"), { ...entry("x".repeat(2000)), omitted: 500 }, ""]);
  expect(f.out.stderr).toBe(
    "showing the latest 2 entries; older ones match too, --lines or --since to see them\n",
  );
  f.out.stdout = "";
  expect(await f.run(["logs", "--json", "--full"])).toBe(0);
  expect(JSON.parse(f.out.stdout.split("\n")[1]!)).toEqual(entry(long));
});

test("a character outside the Basic Multilingual Plane is never cut in half", async () => {
  const f = cli(() => ({
    project: "pantry",
    target: "working",
    entries: [entry("😀".repeat(2001))],
    cursor: "c",
  }));
  expect(await f.run(["logs", "--json"])).toBe(0);
  expect(JSON.parse(f.out.stdout)).toEqual({
    ...entry("😀".repeat(2000)),
    omitted: 1,
  });
});

test("list, doctor and config print their report as JSON", async () => {
  const f = cli((request) => ({ action: request.action, ok: true }));
  for (const read of ["list", "doctor", "config"]) {
    f.out.stdout = "";
    expect(await f.run([read, "--json"])).toBe(0);
    expect(JSON.parse(f.out.stdout)).toEqual({ action: read, ok: true });
  }
});
