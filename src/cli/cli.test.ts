import type { ProjectStatusReport } from "../domain/project-status";
import { expect, test } from "bun:test";
import { formatClock } from "./stop-display";
import { RigError } from "../domain/errors";
import { cliHarness, recordedInLog } from "../../tests/support/cli-harness";

test("bare help exits successfully without contacting the daemon", async () => {
  const cli = cliHarness({ operationId: "test-operation" });
  const exit = await cli.run([]);
  expect(exit).toBe(0);
  expect(cli.text()).toContain("Usage: rig");
  expect(cli.text()).not.toContain("[ERROR]");
  expect(cli.requests.length).toBe(0);
});

test("a lifecycle command sends one correlated daemon request and prints its outcome; it takes no --json", async () => {
  const cli = cliHarness({
    command: () => ({
      project: "pantry",
      target: "stable",
      action: "up",
      outcome: "unchanged",
      operationId: "op-42",
    }),
    operationId: "op-42",
  });
  // An action answers with its exit and a line; --json is for reads.
  expect(await cli.run(["up", "stable", "--project", "pantry", "--json"])).toBe(
    1,
  );
  expect(cli.requests).toEqual([]);
  cli.clear();
  expect(await cli.run(["up", "stable", "--project", "pantry"])).toBe(0);
  expect(cli.requests).toEqual([
    {
      action: "up",
      repoPath: "/workspace",
      target: "stable",
      project: "pantry",
      operationId: "op-42",
    },
  ]);
  expect(cli.text()).toBe("pantry stable unchanged\n");
});

test("status renders observed component states and keeps configured routes visible", async () => {
  const result: ProjectStatusReport = {
    project: "pantry",
    targets: [
      {
        name: "stable",
        kind: "stable",
        branch: "main",
        commit: "abc1234def5678",
        state: "degraded",
        route: "https://pantry.b-relay.com",
        components: [
          {
            name: "web",
            kind: "managed",
            state: "failed",
            port: 3070,
            route: "https://pantry.b-relay.com",
            reason: "exited with code 1",
          },
          { name: "convex", kind: "managed", state: "healthy", port: 3290 },
        ],
      },
    ],
  };
  const cli = cliHarness({
    status: () => result,
    command: () => result,
    operationId: "op-status",
  });
  const exit = await cli.run(["status"]);
  expect(exit).toBe(0);
  expect(cli.text()).toContain("stable  degraded  main@abc1234");
  expect(cli.text()).toContain(
    "web  failed  :3070  https://pantry.b-relay.com",
  );
  expect(cli.text()).toContain("convex  healthy  :3290");
  expect(cli.text()).toContain("Failures\n  stable web: exited with code 1");
  expect(cli.text()).not.toContain("op-status");
});

test("usage errors never call runtime or advertise diagnostics; unexpected failures correlate useful evidence", async () => {
  const { RigError } = await import("../domain/errors");
  const cli = cliHarness({
    command: () => {
      throw new RigError(
        "PROVIDER_START",
        "The web process could not start.",
        "Inspect rig logs stable.",
        { token: "secret" },
      );
    },
    record: recordedInLog,
    operationId: "op-failed",
  });
  expect(await cli.run(["up", "preview"])).toBe(1);
  expect(cli.requests.length).toBe(0);
  expect(cli.text()).not.toContain("Details:");
  expect(cli.text()).toContain("rig up --help");
  cli.clear();
  expect(await cli.run(["up", "stable"])).toBe(1);
  expect(cli.text()).toContain("The web process could not start.");
  expect(cli.text()).toContain("Inspect rig logs stable.");
  expect(cli.text()).toContain("Operation: op-failed");
  expect(cli.text()).toContain("Details: /isolated/.rig/logs/rig/rig.jsonl");
  expect(cli.text()).not.toContain("secret");
  expect(cli.text()).not.toContain("PROVIDER_START");
  expect(cli.events).toContainEqual({
    event: "command.failed",
    level: "error",
    operationId: "op-failed",
    code: "PROVIDER_START",
  });
});

test("a failure during interactive preflight still carries the Operation id next to Details", async () => {
  const { RigError } = await import("../domain/errors");
  const cli = cliHarness({
    command: () => {
      throw new RigError(
        "STATE_CORRUPT",
        "The registry could not be read.",
        "Run rig doctor.",
      );
    },
    record: recordedInLog,
    interaction: {
      async text(): Promise<string> {
        throw new Error("Unexpected prompt");
      },
      async confirm(): Promise<boolean> {
        throw new Error("Unexpected prompt");
      },
    },
    operationId: "op-preflight",
  });
  expect(await cli.run(["init"])).toBe(1);
  expect(cli.text()).toContain("The registry could not be read.");
  expect(cli.text()).toContain("Operation: op-preflight");
  expect(cli.text()).toContain("Details: /isolated/.rig/logs/rig/rig.jsonl");
  expect(cli.events).toContainEqual({
    event: "command.failed",
    level: "error",
    operationId: "op-preflight",
    code: "STATE_CORRUPT",
  });
});

test("an empty Preview branch is a usage error, not the current Branch", async () => {
  const cli = cliHarness({
    command: () => ({}),
    record: recordedInLog,
    operationId: "op-empty",
  });
  for (const args of [
    ["deploy", "preview", ""],
    ["up", "preview", ""],
    ["logs", "preview", ""],
  ]) {
    cli.clear();
    expect(await cli.run(args)).toBe(1);
    expect(cli.text()).toContain("branch");
    expect(cli.text()).toContain("It is empty.");
    expect(cli.text()).toMatch(
      new RegExp(`Run rig ${args[0]}( preview)? --help\\.`),
    );
  }
  expect(cli.requests.length).toBe(0);
});

test("preserves deployment/init options and rejects unsafe destroy before runtime", async () => {
  const cli = cliHarness({
    command: (request) =>
      request.action === "deployment-context"
        ? {
            project: "test",
            repoPath: "/workspace",
            productionBranch: "main",
            currentBranch: "main",
            targets: { working: "working", stable: "stable" },
            selected: "stable",
          }
        : { project: "test", outcome: "unchanged" },
    operationId: "op-options",
  });
  expect(
    await cli.run([
      "deploy",
      "preview",
      "feature/example",
      "--deployment",
      "example",
      "--no-up",
      "--force",
    ]),
  ).toBe(0);
  expect(cli.requests.at(-1)).toMatchObject({
    action: "deploy",
    target: "preview",
    branch: "feature/example",
    deployment: "example",
    force: true,
    noUp: true,
  });
  expect(await cli.run(["forget", "demo"])).toBe(0);
  expect(cli.requests.at(-1)).toMatchObject({
    action: "forget",
    project: "demo",
    repoPath: "/workspace",
  });
  expect(
    await cli.run([
      "init",
      "--path",
      "../other",
      "--project",
      "app",
      "--production-branch",
      "production",
      "--service",
      "web",
      "--command",
      "bun web.ts",
      "--port",
      "3010",
      "--tool",
      "app",
      "--bin",
      "app.ts",
    ]),
  ).toBe(0);
  expect(cli.requests.at(-1)).toMatchObject({
    action: "init",
    repoPath: "/other",
    project: "app",
    productionBranch: "production",
    service: { name: "web", command: "bun web.ts", port: 3010 },
    tool: { name: "app", bin: "app.ts" },
  });
  expect(
    await cli.run(["down", "preview", "--deployment", "example", "--destroy"]),
  ).toBe(0);
  expect(cli.requests.at(-1)).toMatchObject({
    action: "destroy",
    target: "preview",
    deployment: "example",
  });
  const count = cli.requests.length;
  expect(await cli.run(["down", "stable", "--destroy"])).toBe(1);
  expect(cli.requests.length).toBe(count);
  expect(cli.err()).toContain("Preview");
});

test("every command supports both help flags without side effects; removed global options fail", async () => {
  const cli = cliHarness({ operationId: "help" });
  for (const path of [
    [],
    ["list"],
    ["status"],
    ["doctor"],
    ["config"],
    ["activity"],
    ["init"],
    ["up"],
    ["down"],
    ["restart"],
    ["deploy"],
    ["deploy", "stable"],
    ["deploy", "preview"],
    ["logs"],
    ["rename"],
    ["repoint"],
    ["forget"],
  ]) {
    for (const flag of ["--help", "-h"]) {
      cli.clear();
      expect(await cli.run([...path, flag])).toBe(0);
      expect(cli.text()).toContain("Usage: rig");
    }
  }
  expect(cli.requests.length).toBe(0);
  cli.clear();
  expect(await cli.run(["--version"])).toBe(0);
  expect(cli.text().trim()).toBe((await import("../domain/version")).RIG_BUILD);
  expect(cli.requests.length).toBe(0);
  for (const args of [
    ["--log-level", "debug"],
    ["status", "--state-root", "/tmp/forbidden"],
    ["config", "read"],
    ["up", "--json"],
  ])
    expect(await cli.run(args)).toBe(1);
  expect(cli.requests.length).toBe(0);
});

test("follow uses opaque cursors, preserves duplicate lines and exits on cancellation without lifecycle changes", async () => {
  const controller = new AbortController();
  let waits = 0;
  const entry = {
    timestamp: "2026-09-09T09:42:11Z",
    component: "web",
    stream: "stdout",
    line: "same line",
  };
  const cli = cliHarness({
    signal: controller.signal,
    async wait() {
      if (++waits === 3) controller.abort();
    },
    command: () => ({
      project: "pantry",
      target: "stable",
      entries: cli.requests.length === 2 ? [] : [entry],
      cursor: ["cursor-a", "cursor-b", "cursor-c"][cli.requests.length - 1],
    }),
    operationId: "op-logs",
  });
  expect(await cli.run(["logs", "stable", "--follow"])).toBe(0);
  expect(cli.requests).toHaveLength(3);
  expect(cli.requests[1]).toMatchObject({ action: "logs", after: "cursor-a" });
  expect(cli.requests[2]).toMatchObject({ action: "logs", after: "cursor-b" });
  expect(cli.text().match(/same line/g)).toHaveLength(2);
  expect(cli.text().match(/pantry stable/g)).toHaveLength(1);
  expect(cli.text()).toContain("09:42:11Z  web  > same line");
});

test("sink failure preserves success and unexpected error while never advertising an absent file", async () => {
  let failing = false;
  const cli = cliHarness({
    command: () => {
      if (failing) throw new Error("secret provider stack");
      return { project: "pantry", target: "stable", outcome: "started" };
    },
    async record() {
      throw new Error("write failed");
    },
    operationId: "op-no-log",
  });
  expect(await cli.run(["up", "stable"])).toBe(0);
  expect(cli.out()).toContain("pantry stable started");
  expect(cli.err()).toContain("Diagnostic evidence could not be recorded.");
  failing = true;
  cli.clear();
  expect(await cli.run(["up", "stable"])).toBe(1);
  expect(cli.err()).toContain("Rig could not complete this operation.");
  expect(cli.err()).not.toContain("Details:");
  expect(cli.err()).not.toContain("secret provider stack");
});

test("config and doctor expose user views while suppressing editor metadata and passing failure notes", async () => {
  let result: unknown = {
    project: "pantry",
    path: "/repo/rig.yaml",
    format: "yaml",
    revision: "private-revision",
    config: { name: "pantry" },
  };
  const cli = cliHarness({ command: () => result, operationId: "op-views" });
  expect(await cli.run(["config"])).toBe(0);
  expect(cli.text()).toContain("/repo/rig.yaml");
  expect(cli.text()).toContain('"name": "pantry"');
  expect(cli.text()).not.toContain("private-revision");
  cli.clear();
  result = {
    ok: true,
    checks: [
      { name: "daemon", ok: true, message: "healthy", reason: "unreachable" },
    ],
  };
  expect(await cli.run(["doctor"])).toBe(0);
  expect(cli.text()).toBe("Host healthy\nNo problems found.\n");
  cli.clear();
  result = { ok: true, checks: [], project: "pantry" };
  expect(await cli.run(["doctor"])).toBe(0);
  expect(cli.text()).toBe("Host and pantry healthy\nNo problems found.\n");
  cli.clear();
  result = {
    ok: true,
    checks: [],
    note: "Project checks were skipped: no Project selected.",
  };
  expect(await cli.run(["doctor"])).toBe(0);
  expect(cli.text()).toBe(
    "Host healthy\nNo problems found.\nProject checks were skipped: no Project selected.\n",
  );
  cli.clear();
  result = {
    ok: false,
    checks: [
      {
        name: "daemon",
        ok: false,
        message: "Daemon is unreachable.",
        hint: "Run rigd status.",
      },
    ],
  };
  expect(await cli.run(["doctor"])).toBe(1);
  expect(cli.text()).toContain("daemon: Daemon is unreachable.");
  expect(cli.text()).toContain("Run rigd status.");
});

test("scoped JSON also renders usage failures before a daemon request is created", async () => {
  const cli = cliHarness({ command: () => ({}), operationId: "unused" });
  expect(await cli.run(["activity", "--all", "--project", "x", "--json"])).toBe(
    1,
  );
  expect(JSON.parse(cli.out())).toMatchObject({ error: { code: "USAGE" } });
  expect(cli.err()).toBe("");
  expect(cli.requests.length).toBe(0);
  // An action takes no --json, so its refusal is text.
  cli.clear();
  expect(await cli.run(["up", "--json"])).toBe(1);
  expect(cli.out()).toBe("");
  expect(cli.err()).toContain("unknown option");
});

test("cancellation during diagnostics prevents submission of the prepared mutation", async () => {
  const controller = new AbortController();
  const cli = cliHarness({
    root: "/isolated",
    cwd: "/repo",
    signal: controller.signal,
    command: () => ({}),
    async record() {
      controller.abort();
      return {};
    },
    operationId: "cancelled",
  });
  const code = await cli.run(["up", "working"]);
  expect(code).toBe(0);
  expect(cli.requests.length).toBe(0);
});

test("follow reports daemon failure even when cancellation happens during the failed read", async () => {
  const controller = new AbortController();
  const cli = cliHarness({
    signal: controller.signal,
    command: () => {
      if (cli.requests.length === 1) return { entries: [], cursor: "opaque-a" };
      controller.abort();
      throw new Error("daemon failed during read");
    },
    operationId: "follow-failure",
  });
  const exit = await cli.run(["logs", "stable", "--follow"]);
  expect(exit).toBe(1);
  expect(cli.requests.length).toBe(2);
  expect(cli.err()).toContain("Rig could not complete this operation.");
});

for (const when of ["before start", "during wait", "after page"] as const) {
  test(`follow cancellation ${when} stops without another poll`, async () => {
    const controller = new AbortController();
    const { waitForLogPoll } = await import("../adapters/log-follow-scheduler");
    let waits = 0;
    if (when === "before start") controller.abort();
    const start = performance.now();
    const cli = cliHarness({
      signal: controller.signal,
      async wait(milliseconds, signal) {
        waits++;
        expect(milliseconds).toBe(250);
        expect(signal).toBe(controller.signal);
        queueMicrotask(() => controller.abort());
        await waitForLogPoll(milliseconds, signal);
      },
      command: () => ({ entries: [], cursor: "opaque" }),
      output: {
        write() {
          if (when === "after page") controller.abort();
        },
      },
      operationId: "cancel-follow",
    });
    expect(
      await cli.run(["logs", "stable", "--follow"]),
      // Cancelled before its first page, the read never answered; once it follows, cancelling is how the stream ends.
    ).toBe(when === "before start" ? 130 : 0);
    expect(cli.err()).toBe(
      when === "before start"
        ? "The read was interrupted before rigd answered; nothing was printed.\nRun it again.\n"
        : "",
    );
    expect(performance.now() - start).toBeLessThan(250);
    expect(cli.requests.length).toBe(when === "before start" ? 0 : 1);
    expect(waits).toBe(when === "during wait" ? 1 : 0);
  });
}

test("a mutation rigd has not answered after the notice delay tells the user which operation it is waiting behind", async () => {
  let finish!: (value: unknown) => void;
  const stopping = {
    operationId: "slow-down",
    action: "down",
    project: "beta",
    target: "stable",
    phase: "stopping",
    startedAt: "2026-09-14T10:00:00.000Z",
  };
  // What rigd says about this command on each poll: behind a stop (twice), then behind a start, then running.
  const positions = [
    { state: "waiting", waitingOn: [stopping], ahead: 1 },
    { state: "waiting", waitingOn: [stopping], ahead: 1 },
    {
      state: "waiting",
      waitingOn: [{ ...stopping, operationId: "next-up", phase: "starting" }],
      ahead: 0,
    },
    { state: "running", phase: "starting" },
  ];
  const cli = cliHarness({
    async command(request) {
      if (request.action === "queue") {
        expect(request.operation).toBe("mine");
        return { waiting: 2, operations: [], operation: positions.shift() };
      }
      return await new Promise((resolve) => (finish = resolve));
    },
    wait: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    operationId: "mine",
  });
  const asked = () => cli.requests.map((request) => request.action);
  const run = cli.run(["up", "stable", "--project", "beta"]);
  // Polls until rigd has nothing more to say, however slowly the machine runs.
  for (
    const deadline = Date.now() + 5000;
    asked().length < 6 && Date.now() < deadline;
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Polling goes on while the command runs, and stops once rigd has nothing to say about it.
  expect(asked()).toEqual(["up", "queue", "queue", "queue", "queue", "queue"]);
  // One plain appended line per change of what it waits for, with its start in local time; no cursor movement.
  const startedAt = formatClock(new Date("2026-09-14T10:00:00.000Z"), true);
  expect(cli.text()).toBe(
    `Waiting: beta stable is stopping (operation slow-down, started ${startedAt}); 1 more ahead of this command\n` +
      `Waiting: beta stable is starting (operation next-up, started ${startedAt})\n`,
  );
  finish({
    project: "beta",
    target: "stable",
    action: "up",
    outcome: "started",
    operationId: "mine",
  });
  expect(await run).toBe(0);
  expect(cli.text()).toContain("beta stable started");
});

test("rig activity shows each record's message and Operation id, and rig activity <id> asks for that operation", async () => {
  let result: unknown = {
    operations: [
      {
        id: "0b1f2c3d-op",
        project: "app",
        target: "working",
        action: "up",
        outcome: "failed",
        occurredAt: "2026-09-10T22:14:03.120Z",
        message: "PROCESS_START",
      },
      {
        id: "crash-1",
        project: "app",
        target: "working",
        action: "crash",
        outcome: "failed",
        occurredAt: "2026-09-10T22:15:11.004Z",
        message: "web exited with code 137.",
      },
      {
        id: "admin-1",
        action: "daemon-install",
        outcome: "installed",
        occurredAt: "2026-09-10T22:16:00.000Z",
      },
    ],
  };
  const cli = cliHarness({ command: () => result, operationId: "op-activity" });
  expect(await cli.run(["activity"])).toBe(0);
  expect(cli.text()).toBe(
    [
      "2026-09-10T22:14:03.120Z  app  working  up  failed  0b1f2c3d-op",
      "    PROCESS_START",
      "2026-09-10T22:15:11.004Z  app  working  crash  failed  crash-1",
      "    web exited with code 137.",
      "2026-09-10T22:16:00.000Z  daemon-install  installed  admin-1",
      "",
    ].join("\n"),
  );
  expect(cli.requests).toMatchObject([
    { action: "activity", repoPath: "/workspace" },
  ]);
  expect(cli.requests[0]).not.toHaveProperty("operation");
  cli.clear();
  result = { operations: [], operation: "0b1f2c3d-op" };
  expect(await cli.run(["activity", "0b1f2c3d-op"])).toBe(0);
  expect(cli.requests.at(-1)).toMatchObject({
    action: "activity",
    repoPath: "/workspace",
    operation: "0b1f2c3d-op",
  });
  expect(cli.text()).toBe("No activity recorded for Operation 0b1f2c3d-op.\n");
});

test.each([
  "GIT_LOCAL_BRANCH",
  "GIT_REQUIRED",
  "GIT_PATH_MISSING",
  "INVALID_CONFIG",
  "MISSING_CONFIG",
  "PORT_RESERVED",
  "HEALTH_FAILED",
  "BUILD_FAILED",
  "UNAUTHORIZED",
  "PROJECT_MOVED",
  "PREVIEW_NAME",
])(
  "a %s failure the user can correct prints its message and hint without Operation or Details lines",
  async (code) => {
    const cli = cliHarness({
      command: () => {
        throw new RigError(code, "Something you can fix.", "Fix it this way.");
      },
      record: recordedInLog,
      operationId: "op-correctable",
    });
    expect(await cli.run(["up", "stable"])).toBe(1);
    expect(cli.text()).toBe("Something you can fix.\nFix it this way.\n");
    cli.clear();
    // A read with --json reports the same failure as JSON.
    expect(await cli.run(["list", "--json"])).toBe(1);
    expect(JSON.parse(cli.text())).toEqual({
      error: {
        code,
        message: "Something you can fix.",
        hint: "Fix it this way.",
      },
    });
  },
);

test("an invalid --project or --deployment is refused by rig before any request, naming the flag and the rule", async () => {
  const cli = cliHarness({
    command: () => ({}),
    record: recordedInLog,
    operationId: "op-invalid-flag",
  });
  expect(await cli.run(["status", "--project", "a".repeat(129)])).toBe(1);
  expect(cli.text()).toContain("--project");
  expect(cli.text()).toContain("128");
  expect(cli.text()).not.toContain("Operation:");
  for (const args of [
    ["deploy", "preview", "main", "--deployment", "bad name"],
    ["up", "preview", "--deployment", "-lead"],
    ["logs", "preview", "--deployment", "x y"],
    ["down", "preview", "--deployment", ""],
  ]) {
    cli.clear();
    expect(await cli.run(args)).toBe(1);
    expect(cli.text()).toContain("--deployment");
    expect(cli.text()).toContain("letters, digits");
    expect(cli.text()).not.toContain("Operation:");
  }
  expect(cli.requests.length).toBe(0);
});

test("Ctrl-C after a mutation is submitted is acknowledged, and a second one detaches with exit 130", async () => {
  const cancel = new AbortController();
  const detach = new AbortController();
  const submitted: (AbortSignal | undefined)[] = [];
  const cli = cliHarness({
    signal: cancel.signal,
    detach: detach.signal,
    command(request, signal) {
      if (request.action === "queue") return Promise.resolve({});
      submitted.push(signal);
      queueMicrotask(() => cancel.abort());
      return new Promise(() => {});
    },
    output: {
      error(value) {
        if (value.includes("Ctrl-C again")) setTimeout(() => detach.abort(), 5);
      },
    },
    operationId: "slow-up",
  });
  const exit = await cli.run(["up", "working"]);
  const events = cli.events.map((entry) => ({
    event: entry.event,
    ...(entry.operationId ? { operationId: entry.operationId } : {}),
  }));
  expect(exit).toBe(130);
  expect(cli.err()).toContain("rigd is still running up (operation slow-up)");
  expect(cli.err()).toContain("Press Ctrl-C again to detach.");
  expect(cli.err()).toContain("Detached from operation slow-up");
  expect(cli.err()).toContain("rig activity slow-up");
  expect(cli.out()).toBe("");
  expect(submitted).toEqual([detach.signal]);
  expect(events).toEqual([
    { event: "command.started", operationId: "slow-up" },
    { event: "command.detached", operationId: "slow-up" },
  ]);
});

test("a mutation that finishes after the first Ctrl-C still renders its result and exits 0", async () => {
  const cancel = new AbortController();
  const cli = cliHarness({
    signal: cancel.signal,
    detach: new AbortController().signal,
    async command(request) {
      if (request.action === "queue") return {};
      cancel.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        project: "beta",
        target: "stable",
        action: "up",
        outcome: "started",
        operationId: "mine",
      };
    },
    operationId: "mine",
  });
  const exit = await cli.run(["up", "stable", "--project", "beta"]);
  expect(exit).toBe(0);
  expect(cli.err()).toContain("Press Ctrl-C again to detach.");
  expect(cli.out()).toContain("beta stable started");
});

for (const json of [false, true])
  test(`Ctrl-C during a read is passed to the client, and the read that never answered exits 130 (json: ${json})`, async () => {
    const cancel = new AbortController();
    let received: AbortSignal | undefined;
    const cli = cliHarness({
      signal: cancel.signal,
      command(_request, signal) {
        received = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(
              new RigError(
                "CANCELLED",
                "The operation was cancelled.",
                "Retry.",
              ),
            ),
          );
          queueMicrotask(() => cancel.abort());
        });
      },
      operationId: "read",
    });
    const exit = await cli.run(json ? ["list", "--json"] : ["list"]);
    expect(exit).toBe(130);
    expect(received).toBe(cancel.signal);
    const interrupted = {
      code: "CANCELLED",
      message:
        "The read was interrupted before rigd answered; nothing was printed.",
      hint: "Run it again.",
    };
    if (json) {
      expect(JSON.parse(cli.out())).toEqual({ error: interrupted });
      expect(cli.err()).toBe("");
    } else {
      expect(cli.out()).toBe("");
      expect(cli.err()).toBe(`${interrupted.message}\n${interrupted.hint}\n`);
    }
  });

test("help names an unknown command and fails, while help <command> and <command> help show that command's usage", async () => {
  const cli = cliHarness({ operationId: "usage" });
  expect(await cli.run(["help", "nonsense"])).toBe(1);
  expect(cli.text()).toContain("Unknown command 'nonsense'.");
  expect(cli.text()).toContain("Run rig --help.");
  for (const path of [["help", "deploy"], ["deploy", "help"], ["help"]]) {
    cli.clear();
    expect(await cli.run(path)).toBe(0);
    expect(cli.text()).toContain(
      path.length === 1
        ? "Usage: rig "
        : `Usage: rig ${path.filter((part) => part !== "help").join(" ")}`,
    );
  }
});
test("a usage error hints the failing subcommand's own help", async () => {
  const cli = cliHarness({ operationId: "usage" });
  for (const [path, hint] of [
    [["up", "--bogus"], "Run rig up --help."],
    [["deploy", "preview", "--bogus"], "Run rig deploy --help."],
    [
      ["deploy", "stable", "--deployment", "x"],
      "rig deploy preview --deployment",
    ],
    [["nonsense"], "Run rig --help."],
  ] as const) {
    cli.clear();
    expect(await cli.run([...path])).toBe(1);
    expect(cli.text()).toContain(hint);
  }
});
test("an empty option or argument value is refused instead of silently dropped", async () => {
  const cli = cliHarness({ operationId: "usage" });
  for (const [path, flag] of [
    [["init", "--path", ""], "--path"],
    [["init", "--production-branch", ""], "--production-branch"],
    [["init", "--domain", ""], "--domain"],
    [["repoint", ""], "path"],
    [["rename", ""], "name"],
    [["up", "--project", ""], "--project"],
    [["deploy", "preview", "--deployment", "", "main"], "--deployment"],
  ] as const) {
    cli.clear();
    expect(await cli.run([...path])).toBe(1);
    expect(cli.text()).toContain(flag);
    expect(cli.text().toLowerCase()).toContain("empty");
  }
});
