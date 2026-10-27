import { test, expect, spyOn } from "bun:test";
import { startControlPlane } from "../src/daemon/server";
import {
  DaemonClient,
  DEFAULT_READ_DEADLINE_MS,
  LONG_READ_DEADLINE_MS,
} from "../src/daemon/client";
import type { z } from "zod";
import {
  dnsResultSchema,
  doctorResultSchema,
  proxyResultSchema,
  readActions,
  type RuntimeCommand,
} from "../src/daemon/protocol";
import type { DoctorReport } from "../src/runtime/doctor";
import type { ProxyReport } from "../src/adapters/proxy-report";
import type { DnsReport } from "../src/runtime/contracts";

/** Compile-time: the reports rigd builds are what rig accepts, so the schemas cannot drift from them unnoticed. The
 * schemas keep unknown fields, which `Declared` leaves out of the comparison. */
function accepts<Schema extends z.ZodType>(
  _schema: Schema,
  _report: Declared<z.input<Schema>>,
): void {}
type Declared<T> = T extends readonly (infer Item)[]
  ? readonly Declared<Item>[]
  : T extends object
    ? { [K in keyof T as string extends K ? never : K]: Declared<T[K]> }
    : T;
export function rigdReportsAreAccepted(
  doctor: DoctorReport,
  proxy: ProxyReport,
  dns: DnsReport,
): void {
  accepts(doctorResultSchema, doctor);
  accepts(proxyResultSchema, proxy);
  accepts(dnsResultSchema, dns);
}

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
    expect(await client.command({ action: "up" })).toEqual({
      result: "registered",
    });
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(unauthorized.status).toBe(401);
    const probe = await fetch(`http://127.0.0.1:${server.port}/health`, {
      method: "HEAD",
      headers: { authorization: "Bearer test-secret" },
    });
    expect(probe.status).toBe(200);
    expect(await probe.text()).toBe("");
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
  // rigd answers only once the test has seen the deadline expire.
  const answer = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await answer.promise;
      return Response.json({ result: [] });
    },
  });
  try {
    const client = new DaemonClient(
      { port: server.port!, token: "test" },
      { readDeadlineMs: 100 },
    );
    await expect(
      client.command({ action: "list", operationId: "op-slow" }),
    ).rejects.toMatchObject({
      code: "DAEMON_TIMEOUT",
      message:
        "rigd did not answer the list read within 0.1 s; it may be busy (operation op-slow).",
      hint: expect.stringContaining("rig activity"),
    });
  } finally {
    answer.resolve();
    await server.stop(true);
  }
});

test("every read waits 5 s for rigd unless the client is told otherwise, the DNS read and a first logs read 10 minutes; mutations carry no deadline", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ result: { ok: true, checks: [] } }),
  });
  const deadlines = spyOn(AbortSignal, "timeout");
  try {
    const client = new DaemonClient({ port: server.port!, token: "test" });
    for (const action of readActions) {
      deadlines.mockClear();
      // The reply is no valid report for most reads; only the deadline it was asked under counts here.
      await client
        .command({ action, project: "demo" } as RuntimeCommand)
        .catch(() => {});
      expect([action, deadlines.mock.calls]).toEqual([
        action,
        [
          [
            action === "dns" || action === "logs"
              ? LONG_READ_DEADLINE_MS
              : DEFAULT_READ_DEADLINE_MS,
          ],
        ],
      ]);
    }
    // A follow page carries its cursor and reads at most 4 MiB per file.
    deadlines.mockClear();
    await client
      .command({ action: "logs", project: "demo", after: "cursor-1" })
      .catch(() => {});
    expect(deadlines.mock.calls).toEqual([[DEFAULT_READ_DEADLINE_MS]]);
    expect(DEFAULT_READ_DEADLINE_MS).toBe(5000);
    expect(LONG_READ_DEADLINE_MS).toBe(600_000);
    deadlines.mockClear();
    await client.command({ action: "up", project: "demo", target: "working" });
    expect(deadlines).not.toHaveBeenCalled();
  } finally {
    deadlines.mockRestore();
    await server.stop(true);
  }
});

test("a stalled activity, logs or queue read ends at the read deadline, though Bun's fetch idle timeout is off", async () => {
  // rigd answers each after 1 s, long after the deadline, so a read without one waits for that answer instead.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(1000);
      return Response.json({ result: [] });
    },
  });
  try {
    const client = new DaemonClient(
      { port: server.port!, token: "test" },
      { readDeadlineMs: 100 },
    );
    for (const command of [
      { action: "activity" },
      // A follow asks for each page as one such read.
      { action: "logs", project: "demo", after: "cursor-1" },
      { action: "queue", project: "demo", target: "stable" },
    ] as RuntimeCommand[])
      await expect(client.command(command)).rejects.toMatchObject({
        code: "DAEMON_TIMEOUT",
        message: `rigd did not answer the ${command.action} read within 0.1 s; it may be busy.`,
      });
  } finally {
    await server.stop(true);
  }
}, 10000);

test("a slow first logs read scanning old generations returns its page, while a follow page that slow times out", async () => {
  // rigd answers after 1 s, as a read back through many rotated files does, far past a 0.1 s read deadline.
  const page = {
    project: "demo",
    target: "stable",
    entries: [
      {
        timestamp: "2026-10-25T23:59:59.000Z",
        component: "api",
        stream: "stdout",
        line: "listening",
      },
    ],
    cursor: "cursor-2",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(1000);
      return Response.json({ result: page });
    },
  });
  try {
    const client = new DaemonClient(
      { port: server.port!, token: "test" },
      { readDeadlineMs: 100 },
    );
    expect(
      await client.command({
        action: "logs",
        project: "demo",
        target: "stable",
        lines: 100,
        logFilter: { until: "2026-10-26T00:00:00.000Z" },
      }),
    ).toMatchObject(page);
    await expect(
      client.command({
        action: "logs",
        project: "demo",
        target: "stable",
        lines: 1000,
        after: "cursor-2",
      }),
    ).rejects.toMatchObject({
      code: "DAEMON_TIMEOUT",
      message:
        "rigd did not answer the logs read within 0.1 s; it may be busy.",
    });
  } finally {
    await server.stop(true);
  }
}, 10000);

test("no request is left to Bun's fetch idle timeout, and a timeout of a request without a deadline is not reported as unreachable", async () => {
  const fetches = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as unknown as typeof fetch);
  try {
    const client = new DaemonClient({ port: 1, token: "test" });
    await expect(
      client.command({
        action: "deploy",
        project: "melody",
        target: "stable",
        operationId: "op-725",
      }),
    ).rejects.toMatchObject({
      code: "DAEMON_TIMEOUT",
      message:
        "The deploy request timed out before rigd answered (operation op-725); it may still be running.",
      hint: "Run rig activity to see whether it finished.",
    });
    await client.command({ action: "doctor" }).catch(() => {});
    for (const [, init] of fetches.mock.calls)
      expect(init).toMatchObject({ timeout: false });
    expect(fetches).toHaveBeenCalledTimes(2);
  } finally {
    fetches.mockRestore();
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
    name: "working",
    kind: "working",
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

test("human Status sanitizes labels while JSON preserves evidence and valid empty remains empty", async () => {
  const { runRigCli } = await import("../src/cli/rig");
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
    output = "";
    expect(
      await runRigCli(["status", "--project", "demo", "--json"], deps),
    ).toBe(0);
    expect(JSON.stringify(JSON.parse(output))).toBe(JSON.stringify(result));
    result = { project: "demo", targets: [] };
    output = "";
    expect(await runRigCli(["status", "--project", "demo"], deps)).toBe(0);
    expect(output).toBe("demo\n\nNo Targets configured.\n\nNo failures\n");
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
            name: "stable",
            kind: "stable",
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
  const { RIG_BUILD } = await import("../src/domain/version");
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
    expect((await client.health()).version).toBe(RIG_BUILD);
    await expect(
      client.command({ action: "from-the-future" } as never),
    ).rejects.toMatchObject({
      code: "DAEMON_PROTOCOL",
      message: expect.stringContaining(`rig ${RIG_BUILD}`),
      hint: expect.stringContaining("rigd install"),
      details: { rig: RIG_BUILD, rigd: RIG_BUILD },
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
    const logs = ["logs", "working", "--project", "demo"];
    const malformed: [string[], unknown, string][] = [
      [["list"], {}, "No Projects registered."],
      [["list"], { projects: null }, "No Projects registered."],
      [["list"], { projects: [{ name: 1 }] }, "Targets"],
      [logs, {}, "No logs yet."],
      [
        logs,
        { project: "demo", target: "working", entries: "none", cursor: "c" },
        "No logs yet.",
      ],
      [
        logs,
        {
          project: "demo",
          target: "working",
          entries: [{ line: 1 }],
          cursor: "c",
        },
        "No logs yet.",
      ],
      [
        logs,
        { project: "demo", target: "working", entries: [] },
        "No logs yet.",
      ],
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
        projects: [],
      }),
    ).toBe(0);
    expect(output).toBe("No Projects registered.\n");
    expect(
      await run(logs, {
        project: "demo",
        target: "working",
        entries: [],
        cursor: "c1",
      }),
    ).toBe(0);
    expect(output).toBe("demo working\n\nNo logs yet.\n");
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
        { project: "demo", target: "working", entries: [entry], cursor: "c1" },
        {
          project: "demo",
          target: "working",
          entries: [{ line: 2 }],
          cursor: "c2",
        },
        { project: "demo", target: "working", entries: [entry], cursor: "c3" },
      ),
    ).toBe(1);
    expect(output).toContain("10:00:00Z  web  > first page");
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

test("a browser origin is accepted only for the daemon's own loopback address, whatever the Host header says", async () => {
  const server = startControlPlane({
    port: 0,
    token: "test-secret",
    instanceId: "instance-1",
    handle: async () => ({}),
  });
  try {
    const health = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { authorization: "Bearer test-secret", ...headers },
      });
    const rebinding = await health({
      host: `evil.test:${server.port}`,
      origin: `http://evil.test:${server.port}`,
    });
    expect(rebinding.status).toBe(403);
    expect(
      (await health({ origin: `http://127.0.0.1:${server.port}` })).status,
    ).toBe(200);
    expect(
      (await health({ origin: `http://localhost:${server.port}` })).status,
    ).toBe(200);
    expect((await health({ origin: "http://127.0.0.1:1" })).status).toBe(403);
  } finally {
    await server.stop(true);
  }
});

test("doctor, config, proxy and DNS replies that are not their report fail as DAEMON_PROTOCOL in text and JSON, valid empty reports still print, and Doctor's exit follows its validated ok", async () => {
  const { runRigCli } = await import("../src/cli/rig");
  let reply: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ result: reply }),
  });
  const reads = {
    doctor: {
      args: ["doctor"],
      valid: { ok: true, checks: [] },
      nested: { ok: true, checks: [{ name: 7, ok: true, message: "" }] },
    },
    config: {
      args: ["config"],
      valid: {
        project: "demo",
        path: "/repo/rig.yaml",
        revision: "r1",
        config: { name: "demo" },
      },
      nested: {
        project: "demo",
        path: "/repo/rig.yaml",
        revision: "r1",
        config: "name: demo",
      },
    },
    proxy: {
      args: ["proxy"],
      valid: {
        caddy: {
          state: "stopped",
          ports: { http: 80, https: 443 },
          ca: "internal",
        },
        sites: [],
      },
      nested: {
        caddy: {
          state: "running",
          ports: { http: "80", https: 443 },
          ca: "internal",
        },
        sites: [],
      },
    },
    dns: {
      args: ["dns", "list"],
      valid: { provider: "cloudflare", zones: [], records: [], hostnames: [] },
      nested: {
        provider: "cloudflare",
        zones: [{ id: 1, name: "example.com" }],
        records: [],
        hostnames: [],
      },
    },
  };
  try {
    const client = new DaemonClient({ port: server.port!, token: "test" });
    const run = async (args: string[], result: unknown) => {
      reply = result;
      let stdout = "";
      let stderr = "";
      const exit = await runRigCli(args, {
        root: "/tmp/rig-594-transport/.rig",
        cwd: "/repo",
        client,
        output: {
          write(value: string) {
            stdout += value;
          },
          error(value: string) {
            stderr += value;
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
      return { exit, stdout, stderr };
    };
    const protocol = {
      error: {
        code: "DAEMON_PROTOCOL",
        message: "rigd returned an invalid response.",
        hint: "Check that rig and rigd use the same version.",
      },
    };
    for (const [action, read] of Object.entries(reads)) {
      for (const malformed of [null, 42, "report", [], {}, read.nested]) {
        const json = await run([...read.args, "--json"], malformed);
        expect({
          action,
          malformed,
          ...json,
          stdout: JSON.parse(json.stdout),
        }).toEqual({
          action,
          malformed,
          exit: 1,
          stdout: protocol,
          stderr: "",
        });
        const text = await run(read.args, malformed);
        expect({ action, malformed, ...text }).toEqual({
          action,
          malformed,
          exit: 1,
          stdout: "",
          stderr: `${protocol.error.message}\n${protocol.error.hint}\n`,
        });
      }
      const valid = await run([...read.args, "--json"], read.valid);
      expect({
        action,
        exit: valid.exit,
        report: JSON.parse(valid.stdout),
      }).toEqual({ action, exit: 0, report: read.valid });
      expect((await run(read.args, read.valid)).exit).toBe(0);
    }
    // A field rigd adds is kept: --json prints the report whole.
    const extended = { ok: true, checks: [], checkedAt: "2026-10-20T00:00Z" };
    expect(
      JSON.parse((await run(["doctor", "--json"], extended)).stdout),
    ).toEqual(extended);
    const failing = {
      ok: false,
      checks: [
        { name: "rigd", ok: false, message: "The daemon is not reachable." },
      ],
    };
    const doctor = await run(["doctor", "--json"], failing);
    expect({ exit: doctor.exit, report: JSON.parse(doctor.stdout) }).toEqual({
      exit: 1,
      report: failing,
    });
  } finally {
    await server.stop(true);
  }
});
