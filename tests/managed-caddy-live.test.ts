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
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import type { Supervisor } from "../src/providers/contracts";
import { createListenerInspection } from "../src/providers/listener-inspection";
import { probeLocalPort } from "../src/providers/port-probe";
import { createTargetEffects } from "../src/adapters/target-effects";
import { waitForLogPoll } from "../src/adapters/log-follow-scheduler";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import type { TargetRecord } from "../src/domain/runtime";
import { DEFAULT_LOG_RETENTION } from "../src/domain/log-retention";
import {
  dashboardDirectory,
  openDashboard,
  withDashboardRoute,
} from "../src/daemon/dashboard";
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

test("real Caddy never hands a stopped Target's hostname, or the dashboard's, to another program that takes the port: across a down, the dashboard's start, a port in use and a restart", async () => {
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
  const dashboardPort = freePort();
  const route = { domain: "dash.example.test", port: dashboardPort, https };
  const settings = withDashboardRoute(
    parseHostConfig({
      proxy: {
        caddy: source,
        ports: { http: freePort(), https },
        tls: { ca: "internal" },
      },
    }).proxy!,
    route,
  );
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
  // As rigd composes it: the dashboard's domain is withheld until its own process is confirmed on its port.
  let dashboardListening = false;
  const caddy = createManagedCaddy({
    root,
    settings: async () => settings,
    dashboard: () => ({ domain: route.domain, listening: dashboardListening }),
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

  // The dashboard's port is taken before the dashboard starts: its start fails, and its domain never reaches that program.
  const directory = dashboardDirectory(root);
  await mkdir(join(directory, "web"), { recursive: true });
  await writeFile(
    join(directory, "web", "server.js"),
    `Bun.serve({ port: Number(process.env.PORT), hostname: process.env.HOSTNAME, fetch: () => new Response("dashboard") });`,
  );
  const notes: string[] = [];
  const open = () =>
    openDashboard({
      root,
      port: dashboardPort,
      directory,
      executable: process.execPath,
      retention: async () => DEFAULT_LOG_RETENTION,
      notices: {
        note: (_channel, message) => void notes.push(message),
        clear() {},
      },
      listeners: createListenerInspection(runCommand),
      portTaken: async (port) =>
        (await probeLocalPort(port, AbortSignal.timeout(3000))).ready,
      serving: async (listening) => {
        dashboardListening = listening;
        await caddy.refresh();
      },
      wait: (_ms, signal) => waitForLogPoll(200, signal),
      now: Date.now,
    });
  const noted = async () => {
    for (
      let deadline = Date.now() + 10_000;
      !notes.length && Date.now() < deadline;
    )
      await Bun.sleep(100);
  };
  let holder = another(dashboardPort);
  let dashboard = (await open())!;
  dashboard.start();
  await noted();
  expect(notes[0]).toContain(`another program holds port ${dashboardPort}`);
  expect(await get("dash.example.test", https)).toEqual({
    status: 503,
    body: "503 - dash.example.test is currently down",
  });
  expect(holder.received).toEqual([]);

  // Once the port is free, the dashboard's own process takes it and is served.
  holder.stop();
  for (
    let deadline = Date.now() + 15_000;
    (await get("dash.example.test", https)).body !== "dashboard" &&
    Date.now() < deadline;
  )
    await Bun.sleep(200);
  expect(await get("dash.example.test", https)).toEqual({
    status: 200,
    body: "dashboard",
  });

  // rigd restarts: its dashboard is withheld before it stops, and a program that takes the freed port first is never
  // reached, nor while the next dashboard cannot start.
  await dashboard.stop();
  holder = another(dashboardPort);
  notes.length = 0;
  dashboard = (await open())!;
  dashboard.start();
  await noted();
  expect(await get("dash.example.test", https, "/settings")).toEqual({
    status: 503,
    body: "503 - dash.example.test is currently down",
  });
  expect(holder.received).toEqual([]);
  await dashboard.stop();

  // A dashboard that runs, but answers on ::1 while that program holds 127.0.0.1 at its port, is not the one Caddy would
  // reach, so it is never served either.
  await writeFile(
    join(directory, "web", "server.js"),
    `Bun.serve({ port: Number(process.env.PORT), hostname: "::1", fetch: () => new Response("dashboard") });`,
  );
  dashboard = (await open())!;
  dashboard.start();
  for (
    let deadline = Date.now() + 10_000;
    !(await fetch(`http://[::1]:${dashboardPort}`).then(
      () => true,
      () => false,
    )) && Date.now() < deadline;
  )
    await Bun.sleep(100);
  await Bun.sleep(1000);
  expect(await get("dash.example.test", https, "/settings")).toEqual({
    status: 503,
    body: "503 - dash.example.test is currently down",
  });
  expect(holder.received).toEqual([]);
  await dashboard.stop();
}, 90_000);
