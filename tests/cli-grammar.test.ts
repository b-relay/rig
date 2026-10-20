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
    // Both selections, each as a command that works, keeping the --destroy the user typed.
    const destroy = action === "down" ? " --destroy" : "";
    expect(h.err()).toContain(
      `Use rig ${action} preview feature-a${destroy} or rig ${action} preview --deployment feature-b-1a2b3c4d${destroy}.`,
    );
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

test("rig run sends the job for the stable Target unless another is named, and answers --help and -h", async () => {
  const cases: [string[], Partial<RuntimeCommand>][] = [
    [["run", "link-resolver"], { target: "stable" }],
    [["run", "link-resolver", "working"], { target: "working" }],
    [
      ["run", "link-resolver", "preview", "feature/a"],
      { target: "preview", branch: "feature/a" },
    ],
    [
      ["run", "link-resolver", "preview", "--deployment", "feat-1a2b3c4d"],
      { target: "preview", deployment: "feat-1a2b3c4d" },
    ],
  ];
  for (const [args, expected] of cases) {
    const h = harness(() => ({
      outcome: "started",
      project: "melody",
      target: expected.target,
      job: "link-resolver",
    }));
    expect(await runRigCli(args, h.deps)).toBe(0);
    expect(h.requests).toEqual([
      expect.objectContaining({
        action: "run",
        job: "link-resolver",
        repoPath: "/workspace",
        ...expected,
      }),
    ]);
    expect(h.out()).toContain("link-resolver started");
  }
  const bad = harness();
  expect(await runRigCli(["run", "Bad Name"], bad.deps)).toBe(1);
  expect(bad.requests).toEqual([]);
  expect(bad.err()).toContain("is not a job name");
  for (const flag of ["--help", "-h"]) {
    const h = harness();
    expect(await runRigCli(["run", flag], h.deps)).toBe(0);
    expect(h.out()).toContain("Run a scheduled job now");
  }
});

test("a usage hint that corrects a Preview selection retypes the command with its job, backup and Project, and the retyped command runs", async () => {
  const cases: [string[], string][] = [
    [
      ["backup", "list", "--deployment", "login"],
      "rig backup list preview --deployment login",
    ],
    [
      ["backup", "list", "db-backup", "--deployment", "login"],
      "rig backup list db-backup preview --deployment login",
    ],
    [
      ["backup", "restore", "db-backup", "latest", "--deployment", "login"],
      "rig backup restore db-backup latest preview --deployment login",
    ],
    [
      ["run", "db-backup", "--deployment", "login", "--project", "shop"],
      "rig run db-backup preview --deployment login --project shop",
    ],
    [
      ["down", "--deployment", "login", "--destroy"],
      "rig down preview --deployment login --destroy",
    ],
    [
      ["logs", "--deployment", "login", "--service", "web"],
      "rig logs preview --deployment login --service web",
    ],
    [
      ["deploy", "stable", "feature/x", "--deployment", "login", "--no-up"],
      "rig deploy preview feature/x --deployment login --no-up",
    ],
  ];
  for (const [args, retyped] of cases) {
    const h = harness();
    expect(await runRigCli(args, h.deps)).toBe(1);
    expect(h.requests).toEqual([]);
    expect(h.err()).toContain(`Use ${retyped}.`);
    const again = harness((request) =>
      request.action === "logs"
        ? { project: "shop", target: "login", entries: [], cursor: "c" }
        : request.action === "backups"
          ? { project: "shop", backups: [] }
          : request.action === "deployment-context"
            ? {
                project: "shop",
                repoPath: "/workspace",
                productionBranch: "main",
                currentBranch: "feature/x",
                selected: "preview",
              }
            : { outcome: "started" },
    );
    await runRigCli(retyped.split(" ").slice(1), again.deps);
    expect(
      again.requests.find((request) => request.action !== "deployment-context"),
    ).toMatchObject({
      target: "preview",
      deployment: "login",
      ...(args.includes("--project") ? { project: "shop" } : {}),
      ...(args[0] === "run" || args[1] === "restore"
        ? { job: "db-backup" }
        : {}),
    });
  }
  // A selection the grammar cannot read points at the help of the command typed, which exists.
  const h = harness();
  expect(
    await runRigCli(["backup", "list", "db-backup", "preview"], h.deps),
  ).toBe(1);
  expect(h.err()).toContain("Run rig backup list --help.");
});

test("rig backup and rig dns without a subcommand print their help, and rig help backup restore shows that command's", async () => {
  for (const group of ["backup", "dns"]) {
    const h = harness();
    expect(await runRigCli([group], h.deps)).toBe(0);
    expect(h.out()).toContain(`Usage: rig ${group} [options] [command]`);
    expect(h.requests).toEqual([]);
  }
  const help = harness();
  expect(await runRigCli(["help", "backup", "restore"], help.deps)).toBe(0);
  expect(help.out()).toContain("Usage: rig backup restore");
  // The help command's own example names a path it can show.
  const own = harness();
  expect(await runRigCli(["help", "help"], own.deps)).toBe(0);
  expect(own.out()).toContain("for example backup restore");
});

test("help says what a Preview positional selects and which port proxy verify checks", async () => {
  for (const args of [
    ["up", "--help"],
    ["down", "--help"],
    ["restart", "--help"],
    ["logs", "--help"],
    ["run", "--help"],
    ["backup", "list", "--help"],
    ["backup", "restore", "--help"],
  ]) {
    const h = harness();
    expect(await runRigCli(args, h.deps)).toBe(0);
    expect(h.out()).not.toContain("Preview Branch or name");
    expect(h.out()).toContain("--deployment <name>");
  }
  const logs = harness();
  expect(await runRigCli(["logs", "--help"], logs.deps)).toBe(0);
  expect(logs.out()).toContain("rig logs preview --deployment demo");
  const verify = harness();
  expect(await runRigCli(["proxy", "verify", "--help"], verify.deps)).toBe(0);
  expect(verify.out()).toContain("the one Caddy last accepted");
  expect(verify.out()).not.toContain("(default: proxy.ports.https)");
});
