import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { startControlPlane } from "../src/daemon/server";

// Bun's idle timers cannot be shortened from outside, so this waits them out in real time; it lives apart from
// transport.test.ts so the fast tier skips it.
const client = resolve(import.meta.dir, "../src/daemon/client.ts");

test("a mutation that outlives both Bun's server idle timeout (10 s) and its fetch idle timeout still returns its result", async () => {
  // rigd answers a deploy only once it is done; the real one took about 8 minutes.
  const server = startControlPlane({
    port: 0,
    token: "test-secret",
    instanceId: "instance-1",
    handle: async () => {
      await Bun.sleep(12000);
      return { action: "deploy", outcome: "deployed" };
    },
  });
  // The fetch idle timeout (BUN_CONFIG_HTTP_IDLE_TIMEOUT, about 5 minutes by default) is read at start and shortened to
  // 1 s here, so the client runs in its own process.
  const script = `
import { DaemonClient } from ${JSON.stringify(client)};
try {
  const result = await new DaemonClient({ port: ${server.port}, token: "test-secret" }).command({
    action: "deploy", project: "melody", target: "stable", operationId: "op-1",
  });
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
}
`;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
      stdout: "pipe",
      stderr: "inherit",
    });
    const output = JSON.parse(await new Response(child.stdout).text());
    await child.exited;
    expect(output).toEqual({
      result: { action: "deploy", outcome: "deployed" },
    });
  } finally {
    await server.stop(true);
  }
}, 30000);
