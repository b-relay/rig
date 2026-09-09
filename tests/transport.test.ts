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
    expect(await client.command({ action: "list" })).toEqual({
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
            expect(choices[0]?.label).toBe("branchname (unknown)");
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
