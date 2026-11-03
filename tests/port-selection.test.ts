import { test, expect } from "bun:test";
import { createServer, type AddressInfo } from "node:net";
import { createRuntimeFiles } from "../src/adapters/runtime-files";

test("selected preferred port is released before another process acquires it", async () => {
  const files = createRuntimeFiles();
  const first = await files.selectPorts({
    requests: [{ name: "web" }],
    occupied: new Map(),
    policy: "configured",
  });
  const selected = await files.selectPorts({
    requests: [{ name: "web", preferred: first.web! }],
    occupied: new Map(),
    policy: "configured",
  });
  expect(selected).toEqual(first);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const s = Bun.listen({hostname:'127.0.0.1',port:${selected.web},socket:{data(){}}}); process.stdout.write(String(s.port)); s.stop();`,
    ],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe(String(selected.web));
});

test("a port the Target's own running Service holds is granted without a bind, since a restart frees it; another Target's still refuses it", async () => {
  const files = createRuntimeFiles();
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  try {
    const request = { requests: [{ name: "web", preferred: port }] };
    await expect(
      files.selectPorts({
        ...request,
        occupied: new Map(),
        policy: "configured",
      }),
    ).rejects.toMatchObject({ code: "PORT_UNAVAILABLE" });
    expect(
      await files.selectPorts({
        ...request,
        occupied: new Map(),
        policy: "configured",
        held: new Set([port]),
      }),
    ).toEqual({ web: port });
    await expect(
      files.selectPorts({
        ...request,
        occupied: new Map([[port, { target: "stable", project: "demo" }]]),
        policy: "configured",
        held: new Set([port]),
      }),
    ).rejects.toMatchObject({ code: "PORT_RESERVED" });
    await expect(
      files.selectPorts({
        requests: [
          { name: "web", preferred: port },
          { name: "api", preferred: port },
        ],
        occupied: new Map(),
        policy: "configured",
        held: new Set([port]),
      }),
    ).rejects.toMatchObject({ code: "PORT_RESERVED" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("empty, inventory collisions, dynamic preferences, and multiple selections preserve policy", async () => {
  const files = createRuntimeFiles();
  expect(
    await files.selectPorts({
      requests: [],
      occupied: new Map(),
      policy: "configured",
    }),
  ).toEqual({});
  const held = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const occupied = new Map([
    [held.port, { target: "stable", project: "other" }],
  ]);
  try {
    await expect(
      files.selectPorts({
        requests: [{ name: "web", preferred: held.port }],
        occupied,
        policy: "configured",
      }),
    ).rejects.toMatchObject({
      code: "PORT_RESERVED",
      message: `Port ${held.port} pinned for Service 'web' belongs to Target 'stable' of Project 'other'.`,
    });
    await expect(
      files.selectPorts({
        requests: [{ name: "web", preferred: held.port }],
        occupied: new Map(),
        policy: "configured",
      }),
    ).rejects.toMatchObject({ code: "PORT_UNAVAILABLE" });
    const selected = await files.selectPorts({
      requests: [
        { name: "web", preferred: held.port },
        { name: "api", preferred: held.port },
      ],
      occupied,
      policy: "dynamic",
    });
    expect(selected.web).not.toBe(held.port);
    expect(selected.api).not.toBe(held.port);
    expect(selected.web).not.toBe(selected.api);
    expect([...occupied.keys()]).toEqual([held.port]);
    for (const port of Object.values(selected)) {
      const probe = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      });
      probe.stop();
    }
  } finally {
    held.stop();
  }
});

test("partial failure leaves earlier successful probes released", async () => {
  const files = createRuntimeFiles();
  const selected = await files.selectPorts({
    requests: [{ name: "web" }],
    occupied: new Map(),
    policy: "configured",
  });
  const held = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  try {
    await expect(
      files.selectPorts({
        requests: [
          { name: "web", preferred: selected.web! },
          { name: "api", preferred: held.port },
        ],
        occupied: new Map(),
        policy: "configured",
      }),
    ).rejects.toMatchObject({ code: "PORT_UNAVAILABLE" });
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port: selected.web!,
      socket: { data() {} },
    });
    probe.stop();
  } finally {
    held.stop();
  }
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: held.port,
    socket: { data() {} },
  });
  probe.stop();
});
