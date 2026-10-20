import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
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
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import type { Supervisor } from "../src/providers/contracts";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import type { TargetRecord } from "../src/domain/runtime";
import { localActivation } from "./support/activation-doubles";

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

test("real Caddy runs Rig's generations: routes, a withdrawal and Rig's down page, the owner's own route, refused Host config kept pending, and a restart", async () => {
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
    fetch: (request) =>
      new URL(request.url).pathname === "/busy"
        ? new Response("free-space probe failed", { status: 503 })
        : new Response(`app ${new URL(request.url).pathname}`),
  });
  cleanups.push(async () => upstream.stop(true));
  const https = freePort();
  let settings = parseHostConfig({
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

  // A withheld path, and an upstream Caddy cannot reach: Rig's own page. An app's own answer passes through (below).
  await caddy.router.apply(route(null));
  expect(await get("app.example.test", https)).toEqual({
    status: 503,
    body: "503 - app.example.test is currently down",
  });
  await caddy.router.apply(route(`127.0.0.1:${freePort()}`));
  expect(await get("app.example.test", https)).toEqual({
    status: 502,
    body: "502 - app.example.test is currently down",
  });
  await caddy.router.apply(route(`127.0.0.1:${upstream.port}`));
  // An app's own 503 is its answer, not an error Caddy raised: it passes through unchanged.
  expect(await get("app.example.test", https, "/busy")).toEqual({
    status: 503,
    body: "free-space probe failed",
  });

  // The owner's own route, from proxy.routes: a plain reverse proxy, applied by a republish (rig proxy reload). A custom
  // Caddy file an earlier build read is ignored, even one that would take over Rig's hostname.
  await mkdir(join(root, "proxy"), { recursive: true });
  await writeFile(
    paths.retiredCustomFiles[0]!,
    "app.example.test {\n\trespond takeover\n}\n",
  );
  settings = { ...settings, routes: { "own.example.test": upstream.port! } };
  expect(await caddy.republish()).toEqual({ published: true });
  expect(await get("own.example.test", https, "/mine")).toEqual({
    status: 200,
    body: "app /mine",
  });
  expect((await get("app.example.test", https)).body).not.toContain("takeover");
  const accepted = settings;
  // One of the owner's routes may not name a Target's hostname: Caddy would merge the two sites. Rig refuses the settings,
  // records them as pending, and goes on serving and publishing with the ones it accepted.
  settings = {
    ...accepted,
    routes: { ...accepted.routes, "app.example.test": upstream.port! },
  };
  await expect(caddy.republish()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    message: expect.stringContaining("would belong to two owners"),
  });
  await caddy.router.apply(route(`127.0.0.1:${upstream.port}`));
  const pending = await proxyReport({
    root,
    requested: settings,
    job,
    admin,
    targets: [{ id: "app", project: "demo", name: "stable" }],
  });
  expect(pending.pending).toMatchObject({
    fields: ["routes"],
    code: "ROUTE_CONFLICT",
    reason: expect.stringContaining("would belong to two owners"),
  });
  // What is served is still described from the accepted generation.
  expect(pending.caddy.ports).toEqual(accepted.ports);
  settings = accepted;
  // None of it changed what is served.
  expect((await get("own.example.test", https)).body).toBe("app /");
  expect(await get("app.example.test", https, "/x")).toEqual({
    status: 200,
    body: "app /x",
  });

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
    "own.example.test",
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
    expect.objectContaining({ hostname: "own.example.test", ok: true }),
  ]);
  const report = await proxyReport({
    root,
    requested: settings,
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
      hostname: "own.example.test",
      source: "custom",
      upstream: `127.0.0.1:${upstream.port}`,
      certificate: "*.example.test",
    },
  ]);

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

test("real Caddy never hands a stopped Target's hostname to another program that takes its freed port", async () => {
  const source = ["/usr/local/bin/caddy", "/opt/homebrew/bin/caddy"].find(
    existsSync,
  );
  if (!source)
    throw new Error("Managed Caddy integration requires a local caddy.");
  const root = await mkdtemp("/tmp/rig-mc-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const https = freePort();
  const servicePort = freePort();
  const settings = parseHostConfig({
    proxy: {
      caddy: source,
      ports: { http: freePort(), https },
      tls: { ca: "internal" },
    },
  }).proxy!;
  const paths = proxyPaths(root);
  await installCaddyBinary({
    source,
    paths,
    dns: "cloudflare",
    run: runCommand,
  });
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
  /** A program that is not Rig's, listening on `port`; it keeps the path of every request it receives. */
  const another = (port: number) => {
    const received: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request) => {
        received.push(new URL(request.url).pathname);
        return new Response("another program");
      },
    });
    cleanups.push(async () => server.stop(true));
    return { received, stop: () => server.stop(true) };
  };

  // A running, verified Target serving app.example.test from its Service.
  let service: ReturnType<typeof Bun.serve> | undefined = Bun.serve({
    hostname: "127.0.0.1",
    port: servicePort,
    fetch: () => new Response("service"),
  });
  cleanups.push(async () => service?.stop(true));
  const target: TargetRecord = {
    id: "target",
    projectId: "project",
    name: "stable",
    kind: "stable",
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan: {
      project: "demo",
      target: "stable",
      workspacePath: root,
      dataRoot: join(root, "data"),
      deploymentName: "stable",
      branchSlug: "main",
      subdomain: "stable",
      providers: { processSupervisor: "child" },
      preparedComponents: [],
      domain: "app.example.test",
      proxy: { upstream: "web" },
      components: [
        {
          name: "web",
          kind: "managed",
          command: "serve",
          port: servicePort,
          readyTimeout: 1,
          env: {},
          dependsOn: [],
        },
      ],
    },
  };
  const supervisor: Supervisor = {
    observe: async () =>
      service ? { state: "running", pid: process.pid } : { state: "stopped" },
    ensureRunning: async () => ({ outcome: "unchanged" }),
    async stop() {
      service?.stop(true);
      service = undefined;
      return { outcome: "stopped" };
    },
    shutdown: async () => {},
    detach: async () => {},
  };
  const effects = createTargetEffects({
    ...localActivation([servicePort]),
    root,
    recordingTime: () => new Date().toISOString(),
    supervisors: new Map([["child", supervisor]]),
    run: runCommand,
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: caddy.router,
    environment: { PATH: process.env.PATH! },
  });
  await caddy.republish();
  await effects.route(target, { verified: new Set([servicePort]) });
  await job.install();
  for (
    let deadline = Date.now() + 15_000;
    (await get("app.example.test", https)).status === 0 &&
    Date.now() < deadline;
  )
    await Bun.sleep(200);
  expect(await get("app.example.test", https)).toEqual({
    status: 200,
    body: "service",
  });

  // rig down: the hostname is withheld before the Service stops, so a program that takes its port receives nothing.
  await createTargetLifecycle(effects).down(target);
  const squatter = another(servicePort);
  expect(await get("app.example.test", https, "/account")).toEqual({
    status: 503,
    body: "503 - app.example.test is currently down",
  });
  expect(squatter.received).toEqual([]);
}, 60_000);

test("real Caddy never takes a configuration from a rigd killed while it published one: the next rigd's withholding stands", async () => {
  const source = ["/usr/local/bin/caddy", "/opt/homebrew/bin/caddy"].find(
    existsSync,
  );
  if (!source)
    throw new Error("Managed Caddy integration requires a local caddy.");
  const root = await mkdtemp("/tmp/rig-mc-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const https = freePort();
  const dashboardPort = freePort();
  const settings = parseHostConfig({
    proxy: {
      caddy: source,
      ports: { http: freePort(), https },
      tls: { ca: "internal" },
    },
  }).proxy!;
  const paths = proxyPaths(root);
  await installCaddyBinary({
    source,
    paths,
    dns: "cloudflare",
    run: runCommand,
  });
  const admin = createCaddyAdmin(paths.socket);
  const job = createProcessCaddyJob({ root, paths, userHome: home, admin });
  cleanups.push(() => job.remove());
  // The next rigd asks for the dashboard's domain withheld: its dashboard is not found on its port.
  const withheld = { domain: "rig.example.test", port: null };
  const next = createManagedCaddy({
    root,
    settings: async () => settings,
    dashboard: { current: () => withheld, confirmed: async () => withheld },
    run: runCommand,
    job,
    admin,
  });
  await next.republish();
  await job.install();
  for (
    let deadline = Date.now() + 15_000;
    (await get("rig.example.test", https)).status === 0 &&
    Date.now() < deadline;
  )
    await Bun.sleep(200);
  expect((await get("rig.example.test", https)).status).toBe(503);
  // A rigd publishing the domain to its dashboard is killed before its configuration reaches Caddy.
  const old = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "support", "caddy-crash-publisher.ts"),
      root,
      JSON.stringify(settings),
      String(dashboardPort),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  cleanups.push(async () => old.kill("SIGKILL"));
  for (let i = 0; i < 400 && !existsSync(join(root, "held")); i++)
    await Bun.sleep(25);
  expect(existsSync(join(root, "held"))).toBe(true);
  old.kill("SIGKILL");
  await old.exited;
  // Another program takes the port; the next rigd starts and confirms what Caddy serves.
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: dashboardPort,
    fetch: () => new Response("another program"),
  });
  cleanups.push(async () => other.stop(true));
  await next.republish();
  await next.refreshDashboard();
  expect((await get("rig.example.test", https)).status).toBe(503);
  // Whatever the killed rigd left waiting may go on now: nothing of it reaches Caddy.
  await writeFile(join(root, "resume"), "");
  await Bun.sleep(1500);
  expect(await get("rig.example.test", https)).toMatchObject({ status: 503 });
}, 60_000);

test("real Caddy never applies a configuration a crashed rigd sent after the next rigd has confirmed what it serves: the next rigd restarts Caddy first", async () => {
  const source = ["/usr/local/bin/caddy", "/opt/homebrew/bin/caddy"].find(
    existsSync,
  );
  if (!source)
    throw new Error("Managed Caddy integration requires a local caddy.");
  const root = await mkdtemp("/tmp/rig-mc-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const https = freePort();
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("another program"),
  });
  cleanups.push(async () => other.stop(true));
  const settings = parseHostConfig({
    proxy: {
      caddy: source,
      ports: { http: freePort(), https },
      tls: { ca: "internal" },
    },
  }).proxy!;
  const paths = proxyPaths(root);
  await installCaddyBinary({
    source,
    paths,
    dns: "cloudflare",
    run: runCommand,
  });
  const admin = createCaddyAdmin(paths.socket);
  const job = createProcessCaddyJob({ root, paths, userHome: home, admin });
  cleanups.push(() => job.remove());
  const withheld = { domain: "rig.example.test", port: null };
  const managed = (
    route: { domain: string; port: number | null },
    caddyAdmin = admin,
  ) =>
    createManagedCaddy({
      root,
      settings: async () => settings,
      dashboard: { current: () => route, confirmed: async () => route },
      run: runCommand,
      job: createProcessCaddyJob({
        root,
        paths,
        userHome: home,
        admin: caddyAdmin,
      }),
      admin: caddyAdmin,
    });
  await managed(withheld).republish();
  await job.install();
  for (
    let deadline = Date.now() + 15_000;
    (await get("rig.example.test", https)).status === 0 &&
    Date.now() < deadline;
  )
    await Bun.sleep(200);
  // What a rigd routing the dashboard's domain to its port would have Caddy load: captured, not sent.
  let stale: unknown;
  await managed(
    { domain: "rig.example.test", port: other.port! },
    {
      ...admin,
      load: async (config) => {
        stale ??= config;
        return "captured";
      },
    },
  )
    .refreshDashboard()
    .catch(() => {});
  expect(stale).toBeDefined();
  for (let attempt = 0; attempt < 10; attempt++) {
    expect((await get("rig.example.test", https)).status).toBe(503);
    // A rigd sent that load in full and was killed: Caddy holds the request but has not applied it yet.
    const caddyPid = (await job.pid!())!;
    // The next rigd's admin connection is open already, as a rigd that has just started reads Caddy's configuration.
    await admin.config();
    // As the next rigd makes its first request to Caddy, Caddy holds, in full, a load the crashed rigd sent but has not
    // applied it yet: it goes on once that request is on its way too.
    let held = true;
    const resumed = async <T>(request: () => Promise<T>) => {
      if (!held) return request();
      held = false;
      const sender = createConnection(paths.socket);
      await new Promise<void>((resolve, reject) => {
        sender.once("connect", resolve);
        sender.once("error", reject);
      });
      await Bun.sleep(5);
      process.kill(caddyPid, "SIGSTOP");
      await Bun.sleep(5);
      const body = JSON.stringify(stale);
      await new Promise<void>((resolve) =>
        sender.end(
          `POST /load HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          resolve,
        ),
      );
      sender.destroy();
      const answer = request();
      await Bun.sleep(10);
      process.kill(caddyPid, "SIGCONT");
      return answer;
    };
    const next = managed(withheld, {
      ...admin,
      reachable: () => resumed(() => admin.reachable()),
      config: () => resumed(() => admin.config()),
      stop: () => resumed(() => admin.stop()),
    });
    await next.refreshDashboard();
    await Bun.sleep(300);
    expect([attempt, (await get("rig.example.test", https)).status]).toEqual([
      attempt,
      503,
    ]);
    await next.close();
    // Each attempt starts as after a crash: no rigd recorded a clean stop.
    await rm(paths.cleanStop, { force: true });
  }
}, 180_000);

test("real Caddy never applies a load a stopping rigd cancelled after sending it: that rigd records no clean stop, and the next rigd restarts Caddy", async () => {
  const source = ["/usr/local/bin/caddy", "/opt/homebrew/bin/caddy"].find(
    existsSync,
  );
  if (!source)
    throw new Error("Managed Caddy integration requires a local caddy.");
  const root = await mkdtemp("/tmp/rig-mc-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const https = freePort();
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("another program"),
  });
  cleanups.push(async () => other.stop(true));
  const settings = parseHostConfig({
    proxy: {
      caddy: source,
      ports: { http: freePort(), https },
      tls: { ca: "internal" },
    },
  }).proxy!;
  const paths = proxyPaths(root);
  await installCaddyBinary({
    source,
    paths,
    dns: "cloudflare",
    run: runCommand,
  });
  const admin = createCaddyAdmin(paths.socket);
  const job = createProcessCaddyJob({ root, paths, userHome: home, admin });
  cleanups.push(async () => {
    const pid = await job.pid!();
    if (pid) process.kill(pid, "SIGCONT");
    await job.remove();
  });
  const managed = (
    route: { domain: string; port: number | null },
    caddyAdmin = admin,
  ) =>
    createManagedCaddy({
      root,
      settings: async () => settings,
      dashboard: { current: () => route, confirmed: async () => route },
      run: runCommand,
      job: createProcessCaddyJob({
        root,
        paths,
        userHome: home,
        admin: caddyAdmin,
      }),
      admin: caddyAdmin,
    });
  const withheld = { domain: "rig.example.test", port: null };
  const first = managed(withheld);
  await first.republish();
  await job.install();
  await first.close();
  for (
    let deadline = Date.now() + 15_000;
    (await get("rig.example.test", https)).status === 0 &&
    Date.now() < deadline;
  )
    await Bun.sleep(200);
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await get("rig.example.test", https)).status).toBe(503);
    expect(existsSync(paths.cleanStop)).toBe(true);
    // A rigd routes the dashboard's domain to its port; Caddy takes the whole load but has not applied it when that rigd
    // stops, cancelling it.
    const caddyPid = (await job.pid!())!;
    let sent = false;
    const old = managed(
      { domain: "rig.example.test", port: other.port! },
      {
        ...admin,
        load: (config, signal) => {
          process.kill(caddyPid, "SIGSTOP");
          sent = true;
          return admin.load(config, signal);
        },
      },
    );
    const publishing = old.refreshDashboard().catch(() => {});
    for (let i = 0; i < 200 && !sent; i++) await Bun.sleep(10);
    await Bun.sleep(200);
    await old.close();
    await publishing;
    expect(existsSync(paths.cleanStop)).toBe(false);
    // The next rigd starts: Caddy goes on as soon as the next rigd's first request to it is on its way.
    let held = true;
    const resumed = async <T>(request: () => Promise<T>) => {
      if (!held) return request();
      held = false;
      const answer = request();
      await Bun.sleep(10);
      process.kill(caddyPid, "SIGCONT");
      return answer;
    };
    const next = managed(withheld, {
      ...admin,
      reachable: () => resumed(() => admin.reachable()),
      config: () => resumed(() => admin.config()),
      stop: () => resumed(() => admin.stop()),
    });
    await next.refreshDashboard();
    await Bun.sleep(300);
    expect([attempt, (await get("rig.example.test", https)).status]).toEqual([
      attempt,
      503,
    ]);
    await next.close();
  }
}, 180_000);
