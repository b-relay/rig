import { test, expect } from "bun:test";
import { startControlPlane } from "../src/daemon/server";
import { DaemonClient } from "../src/daemon/client";

test("real localhost daemon authenticates clients and rejects foreign browser origins", async () => {
  const received: unknown[] = [];
  const server = startControlPlane({
    port: 0,
    token: "test-secret",
    instanceId: "instance-1",
    handle: async (command) => {
      received.push(command);
      return { result: "registered" };
    },
  });
  try {
    const client = new DaemonClient({
      port: server.port!,
      token: "test-secret",
    });
    expect((await client.health()).instanceId).toBe("instance-1");
    expect(await client.command({ action: "doctor" })).toEqual({
      result: "registered",
    });
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(unauthorized.status).toBe(401);
    const browser = await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: {
        authorization: "Bearer test-secret",
        origin: "https://evil.example",
      },
    });
    expect(browser.status).toBe(403);
    const malformed = await fetch(
      `http://127.0.0.1:${server.port}/v1/command`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify({ action: "execute-shell" }),
      },
    );
    expect(malformed.status).toBe(400);
    expect(received).toHaveLength(1);
  } finally {
    await server.stop(true);
  }
});

test("a reply slower than the read deadline is reported as a timeout naming the operation, not as unreachable", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(5500);
      return Response.json({ result: [] });
    },
  });
  try {
    const client = new DaemonClient({ port: server.port!, token: "test" });
    await expect(
      client.command({ action: "list", operationId: "op-slow" }),
    ).rejects.toMatchObject({
      code: "DAEMON_TIMEOUT",
      message: expect.stringContaining("op-slow"),
      hint: expect.stringContaining("rig activity"),
    });
  } finally {
    await server.stop(true);
  }
}, 10000);

test("a mutation that outlives Bun's default 10 s idle timeout still returns its result", async () => {
  const server = startControlPlane({
    port: 0,
    token: "test-secret",
    instanceId: "instance-1",
    handle: async () => {
      await Bun.sleep(12000);
      return { outcome: "started" };
    },
  });
  try {
    const client = new DaemonClient({
      port: server.port!,
      token: "test-secret",
    });
    expect(
      await client.command({ action: "up", project: "demo", target: "local" }),
    ).toEqual({ outcome: "started" });
  } finally {
    await server.stop(true);
  }
}, 20000);

test("client rejects malformed health and command envelopes as protocol failures", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ resultMissing: true }),
  });
  try {
    const client = new DaemonClient({ port: server.port!, token: "test" });
    await expect(client.health()).rejects.toMatchObject({
      code: "DAEMON_PROTOCOL",
    });
    await expect(client.command({ action: "list" })).rejects.toMatchObject({
      code: "DAEMON_PROTOCOL",
    });
  } finally {
    await server.stop(true);
  }
});

test("status rejects a missing report instead of inventing an empty Project", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ result: {} }),
  });
  try {
    const client = new DaemonClient({ port: server.port!, token: "test" });
    await expect(
      client.command({ action: "status", project: "demo" }),
    ).rejects.toMatchObject({ code: "DAEMON_PROTOCOL" });
  } finally {
    await server.stop(true);
  }
});

test("status validates nested evidence and Project identity while preserving optional and extension data", async () => {
  let result: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ result }),
  });
  const empty = { project: "demo", targets: [] };
  const target = {
    name: "local",
    kind: "local",
    state: "configured",
    components: [],
  };
  try {
    const client = new DaemonClient({ port: server.port!, token: "test" });
    for (result of [
      undefined,
      null,
      [],
      { projects: [] },
      { ...empty, project: "foreign" },
      { ...empty, targets: {} },
      { ...empty, warnings: [17] },
      { ...empty, targets: [null] },
      { ...empty, targets: [{ ...target, kind: "alien" }] },
      { ...empty, targets: [{ ...target, state: "imaginary" }] },
      { ...empty, targets: [{ ...target, components: [{}] }] },
      {
        ...empty,
        targets: [
          {
            ...target,
            components: [{ name: "web", kind: "managed", state: "imaginary" }],
          },
        ],
      },
      {
        ...empty,
        targets: [
          {
            ...target,
            components: [
              { name: "web", kind: "managed", state: "failed", exitCode: "1" },
            ],
          },
        ],
      },
    ]) {
      await expect(client.status({ project: "demo" })).rejects.toMatchObject({
        code: "DAEMON_PROTOCOL",
      });
    }
    result = empty;
    expect(await client.status({ project: "demo" })).toEqual(empty);
    result = {
      ...empty,
      future: { retained: true },
      targets: [
        {
          ...target,
          components: [
            {
              name: "web\u001b[31m\n",
              kind: "managed",
              state: "failed",
              exitCode: 0,
              reason: "failure\nreason",
              future: "keep",
            },
          ],
        },
      ],
    };
    expect(JSON.stringify(await client.status({ project: "demo" }))).toBe(
      JSON.stringify(result),
    );
  } finally {
    await server.stop(true);
  }
});

test("human Status and picker sanitize labels while JSON preserves evidence and valid empty remains empty", async () => {
  const { runRigCli } = await import("../src/cli/rig");
  const { prepareInteractiveRequest } = await import("../src/cli/interaction");
  let result: unknown = {
    project: "demo",
    targets: [
      {
        name: "branch\u001b[31m\nname",
        kind: "preview",
        state: "unknown",
        branch: "feature\nbranch",
        route: "route\nline",
        components: [
          {
            name: "web\u001b[31m\n",
            kind: "managed",
            state: "unknown",
            reason: "unknown\nreason",
          },
        ],
      },
    ],
    warnings: ["warning\u001b[31m\nline"],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ result }),
  });
  try {
    let output = "";
    const client = new DaemonClient({ port: server.port!, token: "test" });
    const deps = {
      root: "/tmp/rig-85-transport/.rig",
      cwd: "/repo",
      client,
      output: {
        write(value: string) {
          output += value;
        },
        error(value: string) {
          output += value;
        },
      },
      diagnostics: {
        async record() {
          return {};
        },
      },
      wait: async () => {},
      newOperationId: () => "status-op",
    };
    expect(await runRigCli(["status", "--project", "demo"], deps)).toBe(0);
    expect(output).toContain("branch name  unknown  feature branch");
    expect(output).toContain("unknown reason");
    expect(output).toContain("Warning: warning line");
    expect(output).not.toContain("\u001b");
    const prepared = await prepareInteractiveRequest(
      { action: "down", project: "demo" },
      {
        ...deps,
        interaction: {
          async select(
            _message: string,
            choices: readonly { value: string; label: string }[],
          ) {
            expect(choices[0]?.label).toBe("branch name (unknown)");
            return choices[0]!.value;
          },
          async text(_message: string, value: string) {
            return value;
          },
          async confirm() {
            return true;
          },
        },
      },
    );
    expect(prepared.deployment).toBe("branch\u001b[31m\nname");
    output = "";
    expect(
      await runRigCli(["status", "--project", "demo", "--json"], deps),
    ).toBe(0);
    expect(JSON.stringify(JSON.parse(output))).toBe(JSON.stringify(result));
    result = { project: "demo", targets: [] };
    output = "";
    expect(await runRigCli(["status", "--project", "demo"], deps)).toBe(0);
    expect(output).toBe("demo\n\nNo Targets configured.\n\nNo failures\n");
    await expect(
      prepareInteractiveRequest(
        { action: "down", project: "demo" },
        {
          ...deps,
          interaction: {
            async select() {
              throw new Error("Empty picker must not open");
            },
            async text(_message, value) {
              return value;
            },
            async confirm() {
              return true;
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "TARGET_REQUIRED" });
    result = { project: "demo", targets: [{}] };
    output = "";
    expect(
      await runRigCli(["status", "--project", "demo", "--json"], deps),
    ).toBe(1);
    expect(output).toContain("DAEMON_PROTOCOL");
    expect(output).not.toContain("No Targets configured");
    expect(output).not.toContain("No failures");
  } finally {
    await server.stop(true);
  }
});

test("status retains each observed state, source identity, and exit evidence across transport", async () => {
  const states = [
    "configured",
    "unknown",
    "healthy",
    "unhealthy",
    "running",
    "starting",
    "stopped",
    "failed",
    "ready",
    "degraded",
  ];
  let result: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ result }),
  });
  try {
    const client = new DaemonClient({ port: server.port!, token: "test" });
    for (const state of states) {
      result = {
        project: "demo",
        warnings: ["configuration unavailable"],
        targets: [
          {
            name: "live",
            kind: "live",
            state,
            branch: "main",
            commit: "abc",
            route: "demo.localhost",
            components: [
              {
                name: "web",
                kind: "managed",
                state: state === "degraded" ? "unhealthy" : state,
                pid: 22,
                port: 4444,
                route: "demo.localhost",
                exitCode: 7,
                reason: "recorded reason",
              },
            ],
          },
        ],
      };
      expect(result).toEqual(await client.status({ project: "demo" }));
    }
  } finally {
    await server.stop(true);
  }
});

test("a command rigd does not accept is reported as version skew naming both versions, and health carries the daemon version", async () => {
  const { RIG_VERSION } = await import("../src/domain/version");
  const server = startControlPlane({
    port: 0,
    token: "test-secret",
    instanceId: "instance-1",
    handle: async () => ({}),
  });
  try {
    const client = new DaemonClient({
      port: server.port!,
      token: "test-secret",
    });
    expect((await client.health()).version).toBe(RIG_VERSION);
    await expect(
      client.command({ action: "from-the-future" } as never),
    ).rejects.toMatchObject({
      code: "DAEMON_PROTOCOL",
      message: expect.stringContaining(`rig ${RIG_VERSION}`),
      hint: expect.stringContaining("rigd install"),
      details: { rig: RIG_VERSION, rigd: RIG_VERSION },
    });
  } finally {
    await server.stop(true);
  }
});

test("malformed list, logs and activity replies fail as protocol errors through the CLI, valid empty collections still render, and a malformed follow page ends the follow", async () => {
  const { runRigCli } = await import("../src/cli/rig");
  let replies: unknown[] = [];
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({
        result: replies.length > 1 ? replies.shift() : replies[0],
      });
    },
  });
  try {
    const client = new DaemonClient({ port: server.port!, token: "test" });
    let output = "";
    const run = (args: string[], ...results: unknown[]) => {
      replies = results;
      output = "";
      bodies.length = 0;
      return runRigCli(args, {
        root: "/tmp/rig-115-transport/.rig",
        cwd: "/repo",
        client,
        output: {
          write(value: string) {
            output += value;
          },
          error(value: string) {
            output += value;
          },
        },
        diagnostics: {
          async record() {
            return {};
          },
        },
        wait: async () => {},
        newOperationId: () => "read-op",
      });
    };
    const logs = ["logs", "local", "--project", "demo"];
    const malformed: [string[], unknown, string][] = [
      [["list"], {}, "No Projects registered."],
      [
        ["list"],
        { ownership: "ready", projects: null },
        "No Projects registered.",
      ],
      [["list"], { ownership: "ready", projects: [{ name: 1 }] }, "Targets"],
      [logs, {}, "No logs yet."],
      [
        logs,
        { project: "demo", target: "local", entries: "none", cursor: "c" },
        "No logs yet.",
      ],
      [
        logs,
        {
          project: "demo",
          target: "local",
          entries: [{ line: 1 }],
          cursor: "c",
        },
        "No logs yet.",
      ],
      [logs, { project: "demo", target: "local", entries: [] }, "No logs yet."],
      [["activity"], {}, "No activity yet."],
      [["activity"], { operations: null }, "No activity yet."],
      [["activity"], { operations: [{}] }, "No activity yet."],
    ];
    for (const [args, reply, empty] of malformed) {
      expect(await run(args, reply)).toBe(1);
      expect(output).toContain("rigd returned an invalid response.");
      expect(output).not.toContain(empty);
    }
    expect(
      await run(["list"], {
        ownership: "ready",
        projects: [],
      }),
    ).toBe(0);
    expect(output).toBe("No Projects registered.\n");
    expect(
      await run(logs, {
        project: "demo",
        target: "local",
        entries: [],
        cursor: "c1",
      }),
    ).toBe(0);
    expect(output).toBe("demo local\n\nNo logs yet.\n");
    expect(await run(["activity"], { operations: [] })).toBe(0);
    expect(output).toBe("No activity yet.\n");
    const entry = {
      timestamp: "2026-09-14T10:00:00Z",
      component: "web",
      stream: "stdout",
      line: "first page",
    };
    expect(
      await run(
        [...logs, "--follow"],
        { project: "demo", target: "local", entries: [entry], cursor: "c1" },
        {
          project: "demo",
          target: "local",
          entries: [{ line: 2 }],
          cursor: "c2",
        },
        { project: "demo", target: "local", entries: [entry], cursor: "c3" },
      ),
    ).toBe(1);
    expect(output).toContain("10:00:00  web  > first page");
    expect(output).toContain("rigd returned an invalid response.");
    expect(output.match(/first page/g)).toHaveLength(1);
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.action)).toEqual(["logs", "logs"]);
    expect(bodies[1]).toMatchObject({ after: "c1" });
  } finally {
    await server.stop(true);
  }
});

test("a read aborted by its signal fails as CANCELLED at once, without waiting for rigd or the read deadline", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch() {
      await Bun.sleep(4000);
      return Response.json({ result: [] });
    },
  });
  try {
    const client = new DaemonClient({ port: server.port!, token: "test" });
    const controller = new AbortController();
    const start = performance.now();
    setTimeout(() => controller.abort(), 20);
    await expect(
      client.command({ action: "list" }, controller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(performance.now() - start).toBeLessThan(1000);
  } finally {
    await server.stop(true);
  }
});
