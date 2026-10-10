import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHostConfig } from "../src/config";
import { proxyPaths } from "../src/domain/managed-proxy";
import { createCaddyAdmin } from "../src/providers/caddy-admin";
import { installCaddyBinary } from "../src/providers/caddy-binary";
import { createProcessCaddyJob } from "../src/providers/caddy-job";
import { runCommand } from "../src/providers/command-runner";
import { createManagedCaddy } from "../src/providers/managed-caddy";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => {});
});
function freePort(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = server.port!;
  server.stop(true);
  return port;
}
/** Requests `path` on `hostname` from the managed Caddy's HTTPS port; its certificate is from Caddy's internal CA. */
async function get(
  hostname: string,
  port: number,
  path = "/",
): Promise<{ status: number; body: string }> {
  const child = Bun.spawn(
    [
      "/usr/bin/curl",
      "-sk",
      "--max-time",
      "5",
      "--resolve",
      `${hostname}:${port}:127.0.0.1`,
      "-w",
      "\n%{http_code}",
      `https://${hostname}:${port}${path}`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const output = await new Response(child.stdout).text();
  await child.exited;
  const lines = output.split("\n");
  return {
    status: Number(lines.at(-1)),
    body: lines.slice(0, -1).join("\n"),
  };
}

test("real Caddy runs Rig's generations: routes, a withdrawal, a custom site, a rejected custom file and a restart", async () => {
  const source = ["/usr/local/bin/caddy", "/opt/homebrew/bin/caddy"].find(
    existsSync,
  );
  if (!source)
    throw new Error("Managed Caddy integration requires a local caddy.");
  // A short root under /tmp keeps the admin socket path within macOS's limit.
  const root = await mkdtemp("/tmp/rig-mc-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => new Response(`app ${new URL(request.url).pathname}`),
  });
  cleanups.push(async () => upstream.stop(true));
  const https = freePort();
  const settings = parseHostConfig({
    proxy: {
      caddy: source,
      ports: { http: freePort(), https },
      tls: { ca: "internal" },
    },
  }).proxy!;
  const paths = proxyPaths(root);
  const installed = await installCaddyBinary({
    source,
    paths,
    dns: "cloudflare",
    run: runCommand,
  });
  expect(installed.changed).toBe(true);
  const admin = createCaddyAdmin(paths.socket);
  const job = createProcessCaddyJob({ root, paths, userHome: home, admin });
  cleanups.push(() => job.remove());
  const caddy = createManagedCaddy({
    root,
    settings: async () => settings,
    run: runCommand,
    job,
    admin,
  });
  const route = (upstreamAddress: string | null) => ({
    key: "app",
    sites: [
      {
        hostname: "app.example.test",
        routes: [{ prefix: "/", upstream: upstreamAddress }],
      },
    ],
  });

  // Caddy is not running yet, confirmed: the change is written and Caddy reads it when it starts.
  await caddy.router.apply(route(`127.0.0.1:${upstream.port}`));
  expect(await job.state()).toBe("stopped");
  await job.install();
  expect(await get("app.example.test", https, "/x")).toEqual({
    status: 200,
    body: "app /x",
  });
  // An unknown name under the generated wildcard is closed, never routed.
  expect((await get("other.example.test", https)).status).toBe(0);

  await caddy.router.apply(route(null));
  expect((await get("app.example.test", https)).status).toBe(503);
  await caddy.router.apply(route(`127.0.0.1:${upstream.port}`));

  await writeFile(
    paths.custom,
    'custom.example.test {\n\trespond "custom"\n}\n',
  );
  await caddy.applyCustom();
  expect(await get("custom.example.test", https)).toEqual({
    status: 200,
    body: "custom",
  });
  await writeFile(
    paths.custom,
    "broken.example.test {\n\tnot_a_directive\n}\n",
  );
  await expect(caddy.applyCustom()).rejects.toMatchObject({
    code: "PROXY_CUSTOM_INVALID",
    message: expect.stringContaining("not_a_directive"),
  });
  // The rejected file changed nothing that is served.
  expect((await get("custom.example.test", https)).body).toBe("custom");
  expect((await get("app.example.test", https)).status).toBe(200);

  await job.restart();
  expect((await get("app.example.test", https)).status).toBe(200);
  await job.remove();
  expect(await job.state()).toBe("stopped");
}, 60_000);
