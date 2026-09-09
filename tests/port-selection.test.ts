import { test, expect } from "bun:test";
import { createRuntimeFiles } from "../src/adapters/runtime-files";

test("selected preferred port is released before another process acquires it", async () => {
  const files = createRuntimeFiles();
  const first = await files.selectPorts({ requests: [{ name: "web" }], occupied: new Set(), policy: "configured" });
  const selected = await files.selectPorts({ requests: [{ name: "web", preferred: first.web! }], occupied: new Set(), policy: "configured" });
  expect(selected).toEqual(first);
  const child = Bun.spawn([process.execPath, "-e", `const s = Bun.listen({hostname:'127.0.0.1',port:${selected.web},socket:{data(){}}}); process.stdout.write(String(s.port)); s.stop();`], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe(String(selected.web));
});

test("empty, inventory collisions, dynamic preferences, and multiple selections preserve policy", async () => {
  const files = createRuntimeFiles();
  expect(await files.selectPorts({ requests: [], occupied: new Set(), policy: "configured" })).toEqual({});
  const held = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const occupied = new Set([held.port]);
  try {
    await expect(files.selectPorts({ requests: [{ name: "web", preferred: held.port }], occupied, policy: "configured" })).rejects.toMatchObject({ code: "PORT_RESERVED" });
    await expect(files.selectPorts({ requests: [{ name: "web", preferred: held.port }], occupied: new Set(), policy: "configured" })).rejects.toMatchObject({ code: "PORT_UNAVAILABLE" });
    const selected = await files.selectPorts({ requests: [{ name: "web", preferred: held.port }, { name: "api", preferred: held.port }], occupied, policy: "dynamic" });
    expect(selected.web).not.toBe(held.port);
    expect(selected.api).not.toBe(held.port);
    expect(selected.web).not.toBe(selected.api);
    expect([...occupied]).toEqual([held.port]);
    for (const port of Object.values(selected)) {
      const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      probe.stop();
    }
  } finally { held.stop(); }
});

test("partial failure leaves earlier successful probes released", async () => {
  const files = createRuntimeFiles();
  const selected = await files.selectPorts({ requests: [{ name: "web" }], occupied: new Set(), policy: "configured" });
  const held = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    await expect(files.selectPorts({ requests: [{ name: "web", preferred: selected.web! }, { name: "api", preferred: held.port }], occupied: new Set(), policy: "configured" })).rejects.toMatchObject({ code: "PORT_UNAVAILABLE" });
    const probe = Bun.listen({ hostname: "127.0.0.1", port: selected.web!, socket: { data() {} } });
    probe.stop();
  } finally { held.stop(); }
  const probe = Bun.listen({ hostname: "127.0.0.1", port: held.port, socket: { data() {} } });
  probe.stop();
});
