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
import { join } from "node:path";
import { DaemonAdmin } from "../src/daemon/admin";
import { createProxyInstallation } from "../src/daemon/proxy-installation";
import { readInstallationRecord } from "../src/daemon/installation";
import { proxyPaths } from "../src/domain/managed-proxy";
import { createCaddyAdmin } from "../src/providers/caddy-admin";
import { runCommand } from "../src/providers/command-runner";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => {});
});
const caddy = ["/usr/local/bin/caddy", "/opt/homebrew/bin/caddy"].find(
  existsSync,
);
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
/** A process-mode Rig root (short, so Caddy's socket path fits) with a stand-in rigd and the real proxy installation. */
async function world() {
  if (!caddy)
    throw new Error("Proxy installation tests require a local caddy.");
  const root = await mkdtemp("/tmp/rig-pi-");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const script = join(root, "child.ts");
  const hostModule = join(import.meta.dir, "../src/daemon/host.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(hostModule)}; await runDaemonHost({root:process.env.RIG_ROOT!,handle:async()=>({ready:true}),shutdown:async()=>{},port:0});`,
  );
  const proxy = createProxyInstallation({
    root,
    userHome: home,
    uid: process.getuid!(),
    mode: "process",
    run: runCommand,
  });
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, script],
    mode: "process",
    userHome: home,
    proxy,
  });
  cleanups.push(async () => {
    await admin.uninstall().catch(() => {});
    await proxy.remove().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const ports = { http: freePort(), https: freePort() };
  return {
    root,
    admin,
    proxy,
    paths: proxyPaths(root),
    caddyAdmin: createCaddyAdmin(proxyPaths(root).socket),
    async config(proxySection: Record<string, unknown> | undefined) {
      await writeFile(
        join(root, "config.yaml"),
        proxySection
          ? `proxy:\n  caddy: ${caddy}\n  ports: { http: ${ports.http}, https: ${ports.https} }\n${Object.entries(
              proxySection,
            )
              .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`)
              .join("")}`
          : "providers:\n  caddy: {}\n",
      );
    },
  };
}

test("rigd install sets up Rig's Caddy before rigd starts, is unchanged when nothing changed, and uninstall stops it but keeps its data", async () => {
  const w = await world();
  await w.config({ tls: { ca: "internal" } });
  expect(await w.admin.install()).toMatchObject({ outcome: "installed" });
  expect(await w.caddyAdmin.reachable()).toBe(true);
  expect(await readInstallationRecord(w.root)).toMatchObject({
    proxy: "managed",
  });
  expect(await readFile(w.paths.entry, "utf8")).toContain("local_certs");
  expect(await readFile(w.paths.custom, "utf8")).toContain(
    "Rig never rewrites this file",
  );
  expect(await w.admin.install()).toMatchObject({ outcome: "unchanged" });

  await w.admin.uninstall();
  expect(await w.caddyAdmin.reachable()).toBe(false);
  expect(await readdir(w.paths.generations)).not.toEqual([]);
  expect(existsSync(w.paths.data)).toBe(true);
}, 60_000);

test("switching back to providers.caddy restarts rigd without Rig's Caddy and stops it", async () => {
  const w = await world();
  await w.config({ tls: { ca: "internal" } });
  await w.admin.install();
  expect(await w.caddyAdmin.reachable()).toBe(true);
  await w.config(undefined);
  const switched = await w.admin.install();
  expect(switched).toMatchObject({ outcome: "installed", replaced: {} });
  expect(await w.caddyAdmin.reachable()).toBe(false);
  expect(await readInstallationRecord(w.root)).toMatchObject({
    proxy: "external",
  });
}, 60_000);

test("without a stored token a production CA refuses the install before anything starts, naming rig proxy token", async () => {
  const w = await world();
  await w.config({ tls: { ca: "letsencrypt-staging" } });
  await expect(w.admin.install()).rejects.toMatchObject({
    code: "PROXY_TOKEN",
    hint: expect.stringContaining("rig proxy token"),
  });
  expect(await w.admin.status()).toMatchObject({
    installed: false,
    running: false,
  });
  expect(await w.caddyAdmin.reachable()).toBe(false);
}, 30_000);

test("a custom file Caddy rejects does not block the install: the accepted copies serve and the install warns", async () => {
  const w = await world();
  await w.config({ tls: { ca: "internal" } });
  await mkdir(join(w.root, "proxy"), { recursive: true });
  await writeFile(
    w.paths.custom,
    "broken.example.test {\n\tnot_a_directive\n}\n",
  );
  const installed = (await w.admin.install()) as { warnings?: string[] };
  expect(installed.warnings?.join("\n")).toContain("not_a_directive");
  expect(await w.caddyAdmin.reachable()).toBe(true);
}, 60_000);

test("switching to Rig's Caddy without a token is refused while rigd keeps running", async () => {
  const w = await world();
  await w.config(undefined);
  await w.admin.install();
  await w.config({ tls: { ca: "letsencrypt" } });
  await expect(w.admin.install()).rejects.toMatchObject({
    code: "PROXY_TOKEN",
  });
  expect(await w.admin.status()).toMatchObject({ reachable: true });
  expect(await readInstallationRecord(w.root)).toMatchObject({
    proxy: "external",
  });
}, 60_000);
