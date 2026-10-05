import { test, expect } from "bun:test";
import { startControlPlane } from "../src/daemon/server";
import { DaemonClient } from "../src/daemon/client";

// Bun's idle timer cannot be shortened from outside the server, so this waits it out in real time; it lives apart from
// transport.test.ts so the fast tier skips it.
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
      await client.command({
        action: "up",
        project: "demo",
        target: "local",
      }),
    ).toEqual({ outcome: "started" });
  } finally {
    await server.stop(true);
  }
}, 20000);
