import { expect, test } from "bun:test";
import type { ProjectStatusReport } from "../src/domain/project-status";
import type { RuntimeCommand } from "../src/daemon/protocol";
import { runRigCli } from "../src/cli/rig";

/** Drives the CLI grammar with an injected client; no daemon, filesystem or terminal. */
function harness(
  reply: (request: RuntimeCommand) => unknown = () => ({ outcome: "started" }),
) {
  const requests: RuntimeCommand[] = [];
  let out = "";
  let err = "";
  const deps = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(selection: RuntimeCommand): Promise<ProjectStatusReport> {
        requests.push({ ...selection, action: "status" });
        return { project: "demo", targets: [] };
      },
      async command(request: RuntimeCommand) {
        requests.push(request);
        return reply(request);
      },
    },
    output: {
      write(value: string) {
        out += value;
      },
      error(value: string) {
        err += value;
      },
    },
    diagnostics: {
      async record() {
        return { path: "/isolated/.rig/logs/rig/rig.jsonl" };
      },
    },
    wait: async () => {},
    newOperationId: () => "op-1",
  };
  return { deps, requests, out: () => out, err: () => err };
}

test("preview commands reject a Branch positional combined with --deployment instead of acting on the deployment", async () => {
  for (const action of ["up", "down", "restart", "logs"]) {
    const h = harness();
    const args = [
      action,
      "preview",
      "feature-a",
      "--deployment",
      "feature-b-1a2b3c4d",
    ];
    if (action === "down") args.push("--destroy");
    expect(await runRigCli(args, h.deps)).toBe(1);
    expect(h.requests).toEqual([]);
    expect(h.err()).toContain(
      "Pass a Preview Branch or --deployment, not both.",
    );
    expect(h.err()).toContain(`rig ${action} preview --deployment <name>`);
  }
});

test("preview commands still accept a Branch alone or --deployment alone", async () => {
  const byBranch = harness();
  expect(await runRigCli(["down", "preview", "feature-a"], byBranch.deps)).toBe(
    0,
  );
  expect(byBranch.requests[0]).toMatchObject({
    action: "down",
    target: "preview",
    branch: "feature-a",
  });
  expect(byBranch.requests[0]).not.toHaveProperty("deployment");
  const byName = harness();
  expect(
    await runRigCli(
      ["down", "preview", "--deployment", "feature-b-1a2b3c4d"],
      byName.deps,
    ),
  ).toBe(0);
  expect(byName.requests[0]).toMatchObject({
    action: "down",
    target: "preview",
    deployment: "feature-b-1a2b3c4d",
  });
  expect(byName.requests[0]).not.toHaveProperty("branch");
});

test("recipe diff is one read request naming the Project scope and the optional Service; list and generate ask the daemon nothing", async () => {
  const all = harness(() => ({
    project: "demo",
    path: "/workspace/rig.yaml",
    findings: [],
  }));
  expect(await runRigCli(["recipe", "diff"], all.deps)).toBe(0);
  expect(all.requests).toEqual([
    { action: "recipe-diff", repoPath: "/workspace", operationId: "op-1" },
  ]);
  const one = harness(() => ({
    project: "demo",
    path: "/workspace/rig.yaml",
    findings: [],
  }));
  expect(
    await runRigCli(["recipe", "diff", "db", "--project", "demo"], one.deps),
  ).toBe(0);
  expect(one.requests).toEqual([
    {
      action: "recipe-diff",
      repoPath: "/workspace",
      project: "demo",
      serviceName: "db",
      operationId: "op-1",
    },
  ]);
  for (const args of [
    ["recipe", "list"],
    ["recipe", "generate", "postgres"],
  ]) {
    const local = harness();
    expect(await runRigCli(args, local.deps)).toBe(0);
    expect(local.requests).toEqual([]);
  }
});

const logsReply =
  (entries: unknown[] = [], filtered?: boolean) =>
  () => ({
    project: "demo",
    target: "local",
    entries,
    cursor: "c",
    ...(filtered === undefined ? {} : { filtered }),
  });
test("rig logs without new flags sends today's request and prints today's output", async () => {
  const h = harness(logsReply());
  expect(await runRigCli(["logs", "local"], h.deps)).toBe(0);
  expect(h.requests).toEqual([
    {
      action: "logs",
      repoPath: "/workspace",
      target: "local",
      lines: 50,
      operationId: "op-1",
    },
  ]);
  expect(h.out()).toBe("demo local\n\nNo logs yet.\n");
});
test("rig logs sends --service, --stream, --since and --until as one filter, with durations resolved against rig's clock", async () => {
  const h = harness(logsReply([], true));
  const deps = { ...h.deps, now: () => new Date("2026-09-28T12:00:00.000Z") };
  expect(
    await runRigCli(
      [
        "logs",
        "local",
        "--service",
        "scheduler",
        "--service",
        "web",
        "--stream",
        "stderr",
        "--since",
        "1h",
        "--until",
        "2026-09-28T11:30:00+00:00",
        "--lines",
        "20",
      ],
      deps,
    ),
  ).toBe(0);
  expect(h.requests).toEqual([
    {
      action: "logs",
      repoPath: "/workspace",
      target: "local",
      lines: 20,
      logFilter: {
        services: ["scheduler", "web"],
        stream: "stderr",
        since: "2026-09-28T11:00:00.000Z",
        until: "2026-09-28T11:30:00.000Z",
      },
      operationId: "op-1",
    },
  ]);
  expect(h.out()).toBe("demo local\n\nNo matching log lines.\n");
});
test("rig logs refuses a malformed time, stream or Service name, and --until with --follow, before asking rigd", async () => {
  for (const [args, message] of [
    [["--since", "yesterday"], "--since 'yesterday' is neither a duration"],
    [["--until", "2026-09-28T03:00:00"], "--until '2026-09-28T03:00:00'"],
    [["--since", "1h", "--until", "2h"], "is later than --until"],
    [["--stream", "health"], "Allowed choices are stdout, stderr"],
    [["--service", "bad name"], "--service 'bad name' is not a Service name"],
    [["--until", "1h", "--follow"], "--until cannot be combined with --follow"],
    [
      Array.from({ length: 65 }, (_, n) => ["--service", `s${n}`]).flat(),
      "--service is given 65 names; rig logs takes at most 64.",
    ],
  ] as const) {
    const h = harness(logsReply());
    expect(await runRigCli(["logs", "local", ...args], h.deps)).toBe(1);
    expect(h.requests).toEqual([]);
    expect(h.err()).toContain(message);
    expect(h.err()).not.toContain("Operation:");
  }
});
test("rig logs --help documents every filter and the time forms", async () => {
  for (const flag of ["--help", "-h"]) {
    const h = harness();
    expect(await runRigCli(["logs", flag], h.deps)).toBe(0);
    const text = h.out();
    for (const expected of [
      "--service <name>",
      "repeat",
      "--stream <stream>",
      '"stdout", "stderr"',
      "--since <time>",
      "--until <time>",
      "1h",
      "2026-09-28T03:00:00Z",
      "--lines <count>",
      "after filtering",
      "--follow",
    ])
      expect(text).toContain(expected);
    expect(h.requests).toEqual([]);
  }
});
