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

test("in a checkout up, down, restart and logs without a Target mean working, and deploy without one means stable", async () => {
  for (const action of ["up", "down", "restart", "logs"]) {
    const h = harness((request) =>
      request.action === "logs"
        ? { project: "demo", target: "working", entries: [], cursor: "c" }
        : { outcome: "started" },
    );
    expect(await runRigCli([action], h.deps)).toBe(0);
    expect(h.requests).toEqual([
      expect.objectContaining({ action, target: "working" }),
    ]);
  }
  const h = harness((request) =>
    request.action === "deployment-context"
      ? {
          project: "demo",
          repoPath: "/workspace",
          productionBranch: "main",
          currentBranch: "main",
          selected: "stable",
        }
      : { outcome: "deployed" },
  );
  expect(await runRigCli(["deploy"], h.deps)).toBe(0);
  expect(h.requests).toEqual([
    expect.objectContaining({
      action: "deployment-context",
      target: "stable",
    }),
    expect.objectContaining({
      action: "deploy",
      target: "stable",
      branch: "main",
    }),
  ]);
  // A Preview is never a default: a Branch or --deployment alone still needs preview.
  for (const args of [
    ["up", "--deployment", "feature-1a2b3c4d"],
    ["deploy", "--deployment", "feature-1a2b3c4d"],
  ]) {
    const refused = harness();
    expect(await runRigCli(args, refused.deps)).toBe(1);
    expect(refused.requests).toEqual([]);
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

const logsReply =
  (entries: unknown[] = [], filtered?: boolean) =>
  () => ({
    project: "demo",
    target: "working",
    entries,
    cursor: "c",
    ...(filtered === undefined ? {} : { filtered }),
  });
test("rig logs without new flags sends today's request and prints today's output", async () => {
  const h = harness(logsReply());
  expect(await runRigCli(["logs", "working"], h.deps)).toBe(0);
  expect(h.requests).toEqual([
    {
      action: "logs",
      repoPath: "/workspace",
      target: "working",
      lines: 50,
      operationId: "op-1",
    },
  ]);
  expect(h.out()).toBe("demo working\n\nNo logs yet.\n");
});
test("rig logs sends --service, --stream, --since and --until as one filter, with durations resolved against rig's clock", async () => {
  const h = harness(logsReply([], true));
  const deps = { ...h.deps, now: () => new Date("2026-09-28T12:00:00.000Z") };
  expect(
    await runRigCli(
      [
        "logs",
        "working",
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
      target: "working",
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
  expect(h.out()).toBe("demo working\n\nNo matching log lines.\n");
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
    expect(await runRigCli(["logs", "working", ...args], h.deps)).toBe(1);
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
