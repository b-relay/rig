import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { verifyProxyCertificates } from "../src/adapters/proxy-verify";
import { proxyReport } from "../src/adapters/proxy-report";
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
  // Caddy issues certificates after it starts answering, so the first handshake may have to wait for one.
  for (
    let deadline = Date.now() + 15_000;
    (await get("app.example.test", https)).status === 0 &&
    Date.now() < deadline;
  )
    await Bun.sleep(200);
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

  // rig proxy verify does real handshakes: Caddy's internal CA is not trusted by the system, so it fails until trusted, and
  // its 12-hour certificates pass the 7-day rule only when the clock is set back.
  const untrusted = await verifyProxyCertificates({
    root,
    port: https,
    stagingOk: false,
    waitMs: 0,
  });
  expect(untrusted.map((verdict) => verdict.hostname)).toEqual([
    "app.example.test",
    "custom.example.test",
  ]);
  expect(untrusted[0]).toMatchObject({
    ok: false,
    problem: expect.stringContaining("not trusted"),
  });
  const internalRoot = await readFile(
    join(paths.data, "pki", "authorities", "local", "root.crt"),
    "utf8",
  );
  expect(
    await verifyProxyCertificates({
      root,
      port: https,
      stagingOk: false,
      waitMs: 0,
      trust: [internalRoot],
      now: () => new Date(Date.now() - 8 * 86_400_000),
    }),
  ).toEqual([
    expect.objectContaining({ hostname: "app.example.test", ok: true }),
    expect.objectContaining({ hostname: "custom.example.test", ok: true }),
  ]);
  const report = await proxyReport({
    root,
    settings,
    job,
    admin,
    targets: [{ id: "app", project: "demo", name: "stable" }],
  });
  expect(report.caddy).toMatchObject({ state: "running", ca: "internal" });
  expect(report.sites).toEqual([
    {
      hostname: "app.example.test",
      source: "target",
      project: "demo",
      target: "stable",
      routes: [{ prefix: "/", upstream: `127.0.0.1:${upstream.port}` }],
      certificate: "*.example.test",
    },
    {
      hostname: "custom.example.test",
      source: "custom",
      certificate: "*.example.test",
    },
  ]);
  // The broken edit is still on disk, unapplied.
  expect(report.custom[0]).toMatchObject({ state: "pending" });

  // A crash between switching generations and reloading: real Caddy still runs an older generation. Startup's republish sees
  // that from what Caddy reports, not from the files, and makes it serve the current one.
  const generations = (await readdir(paths.generations))
    .filter((name) => !/\.(tmp|rejected)$/.test(name))
    .sort();
  const older = join(paths.generations, generations.at(-2)!);
  await runCommand({
    command: [
      paths.binary,
      "reload",
      "--config",
      join(older, "Caddyfile"),
      "--adapter",
      "caddyfile",
    ],
  });
  const current = JSON.parse(
    await readFile(join(paths.current, "adapted.json"), "utf8"),
  );
  expect(Bun.deepEquals(await admin.config(), current)).toBe(false);
  expect(await caddy.republish()).toEqual({ published: false });
  expect(Bun.deepEquals(await admin.config(), current)).toBe(true);

  await job.restart();
  expect((await get("app.example.test", https)).status).toBe(200);
  await job.remove();
  expect(await job.state()).toBe("stopped");
}, 60_000);
