import type { ProjectStatusReport } from "../domain/project-status";
import { expect, test } from "bun:test";
import { runRigCli } from "./rig";

test("bare help exits successfully without contacting the daemon", async () => {
  let text = "";
  let calls = 0;
  const exit = await runRigCli([], {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command() {
        calls++;
        return {};
      },
    },
    output: {
      write(value) {
        text += value;
      },
      error(value) {
        text += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "test-operation",
  });
  expect(exit).toBe(0);
  expect(text).toContain("Usage: rig");
  expect(text).not.toContain("[ERROR]");
  expect(calls).toBe(0);
});

test("status and scoped structured lifecycle output use one correlated daemon request", async () => {
  const requests: unknown[] = [];
  let text = "";
  const dependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command(request: unknown) {
        requests.push(request);
        return {
          project: "pantry",
          target: "live",
          action: "up",
          outcome: "unchanged",
          operationId: "op-42",
        };
      },
    },
    output: {
      write(value: string) {
        text += value;
      },
      error(value: string) {
        text += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "op-42",
  };
  expect(
    await runRigCli(
      ["up", "live", "--project", "pantry", "--json"],
      dependencies,
    ),
  ).toBe(0);
  expect(requests).toEqual([
    {
      action: "up",
      repoPath: "/workspace",
      target: "live",
      project: "pantry",
      operationId: "op-42",
    },
  ]);
  expect(JSON.parse(text)).toEqual({
    project: "pantry",
    target: "live",
    action: "up",
    outcome: "unchanged",
    operationId: "op-42",
  });
  text = "";
  expect(
    await runRigCli(["up", "live", "--project", "pantry"], dependencies),
  ).toBe(0);
  expect(text).toBe("pantry live unchanged\n");
});

test("status renders observed component states and keeps configured routes visible", async () => {
  let text = "";
  const result: ProjectStatusReport = {
    project: "pantry",
    targets: [
      {
        name: "live",
        kind: "live",
        branch: "main",
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
  const exit = await runRigCli(["status"], {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status() {
        return result;
      },
      async command() {
        return result;
      },
    },
    output: {
      write(value) {
        text += value;
      },
      error(value) {
        text += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "op-status",
  });
  expect(exit).toBe(0);
  expect(text).toContain("live  degraded  main");
  expect(text).toContain("web  failed  :3070  https://pantry.b-relay.com");
  expect(text).toContain("convex  healthy  :3290");
  expect(text).toContain("Failures\n  live web: exited with code 1");
  expect(text).not.toContain("op-status");
});

test("usage errors never call runtime or advertise diagnostics; unexpected failures correlate useful evidence", async () => {
  const { RigError } = await import("../domain/errors");
  let text = "";
  let calls = 0;
  const events: unknown[] = [];
  const dependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command() {
        calls++;
        throw new RigError(
          "PROVIDER_START",
          "The web process could not start.",
          "Inspect rig logs live.",
          { token: "secret" },
        );
      },
    },
    output: {
      write(value: string) {
        text += value;
      },
      error(value: string) {
        text += value;
      },
    },
    diagnostics: {
      async record(entry: unknown) {
        events.push(entry);
        return { path: "/isolated/.rig/logs/rig/rig.jsonl" };
      },
    },
    wait: async () => {},
    newOperationId: () => "op-failed",
  };
  expect(await runRigCli(["up", "preview"], dependencies)).toBe(1);
  expect(calls).toBe(0);
  expect(text).not.toContain("Details:");
  expect(text).toContain("rig up --help");
  text = "";
  expect(await runRigCli(["up", "live"], dependencies)).toBe(1);
  expect(text).toContain("The web process could not start.");
  expect(text).toContain("Inspect rig logs live.");
  expect(text).toContain("Operation: op-failed");
  expect(text).toContain("Details: /isolated/.rig/logs/rig/rig.jsonl");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("PROVIDER_START");
  expect(events).toContainEqual({
    event: "command.failed",
    level: "error",
    operationId: "op-failed",
    code: "PROVIDER_START",
  });
});

test("preserves deployment/init options and rejects unsafe destroy before runtime", async () => {
  const requests: any[] = [];
  let error = "";
  const dependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command(request: unknown) {
        requests.push(request);
        return { project: "test", outcome: "unchanged" };
      },
    },
    output: {
      write() {},
      error(value: string) {
        error += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "op-options",
  };
  expect(
    await runRigCli(
      [
        "deploy",
        "preview",
        "feature/example",
        "--deployment",
        "example",
        "--no-up",
        "--force",
      ],
      dependencies,
    ),
  ).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    action: "deploy",
    target: "preview",
    branch: "feature/example",
    deployment: "example",
    force: true,
    noUp: true,
  });
  expect(
    await runRigCli(
      [
        "init",
        "--path",
        "../other",
        "--project",
        "app",
        "--production-branch",
        "production",
        "--uses",
        "sqlite,postgres",
        "--managed",
        "web",
        "--managed-command",
        "bun web.ts",
        "--managed-port",
        "3010",
        "--installed",
        "app",
        "--installed-entrypoint",
        "app.ts",
      ],
      dependencies,
    ),
  ).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    action: "init",
    repoPath: "/other",
    project: "app",
    productionBranch: "production",
    uses: ["sqlite", "postgres"],
    managed: { name: "web", command: "bun web.ts", port: 3010 },
    installed: { name: "app", entrypoint: "app.ts" },
  });
  expect(
    await runRigCli(
      ["down", "preview", "--deployment", "example", "--destroy"],
      dependencies,
    ),
  ).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    action: "destroy",
    target: "preview",
    deployment: "example",
  });
  const count = requests.length;
  expect(await runRigCli(["down", "live", "--destroy"], dependencies)).toBe(1);
  expect(requests.length).toBe(count);
  expect(error).toContain("Preview");
});

test("every command supports both help flags without side effects; removed global options fail", async () => {
  let calls = 0;
  let text = "";
  const dependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command() {
        calls++;
        return {};
      },
    },
    output: {
      write(value: string) {
        text += value;
      },
      error(value: string) {
        text += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "help",
  };
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
    ["deploy", "live"],
    ["deploy", "preview"],
    ["logs"],
    ["rename"],
    ["repoint"],
  ]) {
    for (const flag of ["--help", "-h"]) {
      text = "";
      expect(await runRigCli([...path, flag], dependencies)).toBe(0);
      expect(text).toContain("Usage: rig");
    }
  }
  expect(calls).toBe(0);
  for (const args of [
    ["--log-level", "debug"],
    ["status", "--state-root", "/tmp/forbidden"],
    ["config", "read"],
    ["list", "--json"],
  ])
    expect(await runRigCli(args, dependencies)).toBe(1);
  expect(calls).toBe(0);
});

test("follow uses opaque cursors, preserves duplicate lines and exits on cancellation without lifecycle changes", async () => {
  const controller = new AbortController();
  let text = "";
  const requests: any[] = [];
  let waits = 0;
  const entry = {
    timestamp: "2026-09-09T09:42:11Z",
    component: "web",
    stream: "stdout",
    line: "same line",
  };
  const dependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    signal: controller.signal,
    async wait() {
      if (++waits === 3) controller.abort();
    },
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command(request: unknown) {
        requests.push(request);
        return {
          project: "pantry",
          target: "live",
          entries: requests.length === 2 ? [] : [entry],
          cursor: ["cursor-a", "cursor-b", "cursor-c"][requests.length - 1],
        };
      },
    },
    output: {
      write(value: string) {
        text += value;
      },
      error(value: string) {
        text += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    newOperationId: () => "op-logs",
  };
  expect(await runRigCli(["logs", "live", "--follow"], dependencies)).toBe(0);
  expect(requests).toHaveLength(3);
  expect(requests[1]).toMatchObject({ action: "logs", after: "cursor-a" });
  expect(requests[2]).toMatchObject({ action: "logs", after: "cursor-b" });
  expect(text.match(/same line/g)).toHaveLength(2);
  expect(text.match(/pantry live/g)).toHaveLength(1);
  expect(text).toContain("09:42:11  web  > same line");
});

test("sink failure preserves success and unexpected error while never advertising an absent file", async () => {
  let output = "";
  let error = "";
  let failing = false;
  const dependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command() {
        if (failing) throw new Error("secret provider stack");
        return { project: "pantry", target: "live", outcome: "started" };
      },
    },
    output: {
      write(value: string) {
        output += value;
      },
      error(value: string) {
        error += value;
      },
    },
    diagnostics: {
      async record() {
        throw new Error("write failed");
      },
    },
    wait: async () => {},
    newOperationId: () => "op-no-log",
  };
  expect(await runRigCli(["up", "live"], dependencies)).toBe(0);
  expect(output).toContain("pantry live started");
  expect(error).toContain("Diagnostic evidence could not be recorded.");
  failing = true;
  output = "";
  error = "";
  expect(await runRigCli(["up", "live"], dependencies)).toBe(1);
  expect(error).toContain("Rig could not complete this operation.");
  expect(error).not.toContain("Details:");
  expect(error).not.toContain("secret provider stack");
});

test("config and doctor expose user views while suppressing editor metadata and passing failure notes", async () => {
  let text = "";
  let result: unknown = {
    project: "pantry",
    path: "/repo/rig.yaml",
    format: "yaml",
    revision: "private-revision",
    config: { name: "pantry" },
  };
  const dependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command() {
        return result;
      },
    },
    output: {
      write(value: string) {
        text += value;
      },
      error(value: string) {
        text += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "op-views",
  };
  expect(await runRigCli(["config"], dependencies)).toBe(0);
  expect(text).toContain("/repo/rig.yaml");
  expect(text).toContain('"name": "pantry"');
  expect(text).not.toContain("private-revision");
  text = "";
  result = {
    ok: true,
    checks: [
      { name: "daemon", ok: true, message: "healthy", reason: "unreachable" },
    ],
  };
  expect(await runRigCli(["doctor"], dependencies)).toBe(0);
  expect(text).toBe("Host healthy\nNo problems found.\n");
  text = "";
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
  expect(await runRigCli(["doctor"], dependencies)).toBe(1);
  expect(text).toContain("daemon: Daemon is unreachable.");
  expect(text).toContain("Run rigd status.");
});

test("scoped JSON also renders usage failures before a daemon request is created", async () => {
  let text = "",
    errors = "",
    calls = 0;
  const dependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command() {
        calls++;
        return {};
      },
    },
    output: {
      write(value: string) {
        text += value;
      },
      error(value: string) {
        errors += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "unused",
  };
  expect(await runRigCli(["up", "nonsense", "--json"], dependencies)).toBe(1);
  expect(JSON.parse(text)).toMatchObject({ error: { code: "USAGE" } });
  expect(errors).toBe("");
  expect(calls).toBe(0);
  text = "";
  expect(await runRigCli(["config", "--json"], dependencies)).toBe(1);
  expect(text).toBe("");
  expect(errors).toContain("unknown option");
});

test("cancellation during diagnostics prevents submission of the prepared mutation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const code = await runRigCli(["up", "local"], {
    root: "/isolated",
    cwd: "/repo",
    signal: controller.signal,
    client: {
      async status(): Promise<ProjectStatusReport> {
        throw new Error("Unexpected status read");
      },
      async command() {
        calls++;
        return {};
      },
    },
    output: { write() {}, error() {} },
    diagnostics: {
      async record() {
        controller.abort();
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "cancelled",
  });
  expect(code).toBe(0);
  expect(calls).toBe(0);
});

test("follow reports daemon failure even when cancellation happens during the failed read", async () => {
  const controller = new AbortController();
  let calls = 0;
  let errors = "";
  const exit = await runRigCli(["logs", "live", "--follow"], {
    root: "/isolated/.rig", cwd: "/workspace", signal: controller.signal,
    wait: async () => {},
    client: {
      async status(): Promise<ProjectStatusReport> { throw new Error("Unexpected status"); },
      async command() {
        if (++calls === 1) return { entries: [], cursor: "opaque-a" };
        controller.abort();
        throw new Error("daemon failed during read");
      },
    },
    output: { write() {}, error(value) { errors += value; } },
    diagnostics: { async record() { return {}; } },
    newOperationId: () => "follow-failure",
  });
  expect(exit).toBe(1);
  expect(calls).toBe(2);
  expect(errors).toContain("Rig could not complete this operation.");
});

for (const when of ["before start", "during wait", "after page"] as const) {
  test(`follow cancellation ${when} stops without another poll`, async () => {
    const controller = new AbortController();
    const { waitForLogPoll } = await import("../adapters/log-follow-scheduler");
    let polls = 0, waits = 0;
    if (when === "before start") controller.abort();
    const start = performance.now();
    expect(await runRigCli(["logs", "live", "--follow"], {
      root: "/isolated/.rig", cwd: "/workspace", signal: controller.signal,
      async wait(milliseconds, signal) {
        waits++;
        expect(milliseconds).toBe(250);
        expect(signal).toBe(controller.signal);
        queueMicrotask(() => controller.abort());
        await waitForLogPoll(milliseconds, signal);
      },
      client: {
        async status() { throw new Error("Unexpected status"); },
        async command() { polls++; return { entries: [], cursor: "opaque" }; },
      },
      output: { write() { if (when === "after page") controller.abort(); }, error(value) { throw new Error(value); } },
      diagnostics: { async record() { return {}; } },
      newOperationId: () => "cancel-follow",
    })).toBe(0);
    expect(performance.now() - start).toBeLessThan(250);
    expect(polls).toBe(when === "before start" ? 0 : 1);
    expect(waits).toBe(when === "during wait" ? 1 : 0);
  });
}
