import { expect, test } from "bun:test";
import { resolve } from "node:path";

/* Issue #725: `rig deploy` printed "rigd is not reachable." part-way through a deploy that rigd kept running and finished.
 * A mutation carries no client deadline (#204), but Bun's fetch has its own socket idle timeout, 5 minutes by default
 * (BUN_CONFIG_HTTP_IDLE_TIMEOUT), and rigd sends nothing on the request until the command is done. The client reports that
 * timeout as DAEMON_UNREACHABLE. The idle timeout is shortened here so the test runs in seconds; Bun reads it at start, so
 * the client runs in its own process. */

const client = resolve(import.meta.dir, "../src/daemon/client.ts");
const script = `
import { DaemonClient } from ${JSON.stringify(client)};
// rigd answers the deploy after 12 s, as the real one did after about 8 minutes.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch() {
    await Bun.sleep(12000);
    return Response.json({ result: { action: "deploy", outcome: "deployed" } });
  },
});
try {
  const result = await new DaemonClient({ port: server.port, token: "test" }).command({
    action: "deploy", project: "melody", target: "stable", operationId: "op-725",
  });
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
} finally {
  server.stop(true);
}
`;

test("#725: a deploy that rigd answers after the fetch idle timeout returns its result, not 'rigd is not reachable.'", async () => {
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = JSON.parse(await new Response(child.stdout).text());
  await child.exited;
  // Fails at v1.0.1: {"code":"DAEMON_UNREACHABLE","message":"rigd is not reachable."} after about 8 s.
  expect(output).toEqual({
    result: { action: "deploy", outcome: "deployed" },
  });
}, 30000);
