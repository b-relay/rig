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
