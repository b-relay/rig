import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { binaryPending } from "../src/providers/caddy-binary";
import { join } from "node:path";
import { DaemonAdmin } from "../src/daemon/admin";
import {
  createProxyInstallation,
  type ProxyInstallation,
} from "../src/daemon/proxy-installation";
import { processExists } from "../src/daemon/host";
import { dashboardDirectory, dashboardServing } from "../src/daemon/dashboard";
import { readHostConfig } from "../src/config";
import { createProcessCaddyJob } from "../src/providers/caddy-job";
import { createManagedCaddy } from "../src/providers/managed-caddy";
import { currentGeneration } from "../src/adapters/proxy-generation";
import { RigError } from "../src/domain/errors";
import { rigFixture } from "./support/rig-fixture";
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
    userName: "test",
    mode: "process",
    run: runCommand,
    startDeadlineMs: 8000,
  });
  /** rigd's administration of this root, with `installation` setting up and taking down its Caddy. */
  const adminWith = (installation: ProxyInstallation) =>
    new DaemonAdmin({
      root,
      command: [process.execPath, script],
      mode: "process",
      userHome: home,
      proxy: installation,
    });
  const admin = adminWith(proxy);
  cleanups.push(async () => {
    await admin.uninstall().catch(() => {});
    await proxy.remove().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const ports = { http: freePort(), https: freePort() };
  return {
    root,
    admin,
    adminWith,
    proxy,
    ports,
    paths: proxyPaths(root),
    caddyAdmin: createCaddyAdmin(proxyPaths(root).socket),
    async config(
      proxySection: Record<string, unknown> | undefined,
      binary = caddy,
    ) {
      await writeFile(
        join(root, "config.yaml"),
        proxySection
          ? `proxy:\n  caddy: ${binary}\n  ports: { http: ${ports.http}, https: ${ports.https} }\n${Object.entries(
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
  expect(await readFile(w.paths.entry, "utf8")).toContain(
    '"module":"internal"',
  );
  // No custom Caddy file: the owner's own hostnames are proxy.routes in Host config.
  expect(existsSync(join(w.root, "proxy", "custom.caddy"))).toBe(false);
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

test("rigd install serves proxy.routes from Host config", async () => {
  const w = await world();
  await w.config({
    tls: { ca: "internal" },
    routes: { "own.example.test": 3999 },
  });
  await w.admin.install();
  expect(await readFile(w.paths.entry, "utf8")).toContain("127.0.0.1:3999");
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

test("a new Caddy that passes every check but cannot run is swapped back: the previous one serves again and nothing is left pending", async () => {
  const w = await world();
  await w.config({ tls: { ca: "internal" } });
  await w.admin.install();
  const good = await readlink(w.paths.binary);
  // Answers version, modules, validate, adapt and reload as Caddy does, and fails when started.
  const broken = join(w.root, "broken-caddy");
  await writeFile(
    broken,
    `#!/bin/sh\ncase "$1" in run) echo "this Caddy cannot start" >&2; exit 1;; *) exec ${caddy} "$@";; esac\n`,
  );
  await chmod(broken, 0o755);
  await w.config({ tls: { ca: "internal" } }, broken);
  await expect(w.admin.install()).rejects.toMatchObject({
    code: "PROXY_BINARY_START",
  });
  expect(await readlink(w.paths.binary)).toBe(good);
  expect(await binaryPending(w.paths)).toBe(false);
  expect(await w.caddyAdmin.reachable()).toBe(true);
  // rigd was started again despite the failure.
  expect(await w.admin.status()).toMatchObject({ reachable: true });
}, 90_000);

/** The pid a record (rigd's address, Caddy's process record) names. */
async function recordedPid(file: string): Promise<number> {
  return (JSON.parse(await readFile(file, "utf8")) as { pid: number }).pid;
}
async function stopRigd(root: string): Promise<void> {
  const pid = await recordedPid(join(root, "daemon", "address.json"));
  process.kill(pid, "SIGTERM");
  for (
    const deadline = Date.now() + 5000;
    processExists(pid) && Date.now() < deadline;
  )
    await Bun.sleep(50);
}

test("an uninstall whose Caddy removal fails is finished by the next one: refused with rigd running or stopped, and when Caddy stopped but its record stayed", async () => {
  for (const failure of ["refused", "refused, rigd stopped", "record"]) {
    const w = await world();
    await w.config({ tls: { ca: "internal" } });
    await w.admin.install();
    const caddyPid = await recordedPid(w.paths.processRecord);
    const record = await readFile(w.paths.processRecord, "utf8");
    if (failure === "refused, rigd stopped") await stopRigd(w.root);
    // A refusal before Caddy stops, as launchctl's can be; or Caddy stops and its record cannot be removed, since a
    // directory stands where it was.
    let refuse = failure !== "record";
    if (failure === "record") {
      await rm(w.paths.processRecord);
      await mkdir(w.paths.processRecord);
    }
    const admin = w.adminWith({
      ...w.proxy,
      async remove() {
        if (!refuse) return w.proxy.remove();
        refuse = false;
        throw new RigError(
          "LAUNCHD",
          "Injected refusal to remove Rig's Caddy.",
          "Retry rigd uninstall.",
        );
      },
    });
    await expect(admin.uninstall()).rejects.toBeDefined();
    expect(processExists(caddyPid)).toBe(failure !== "record");
    if (failure === "record") {
      await rm(w.paths.processRecord, { recursive: true });
      await writeFile(w.paths.processRecord, record);
    }
    expect(await admin.uninstall()).toMatchObject({
      outcome: "uninstalled",
      installed: false,
    });
    expect(processExists(caddyPid)).toBe(false);
    expect(existsSync(w.paths.processRecord)).toBe(false);
    // Certificates and generations stay for the next install.
    expect(existsSync(w.paths.data)).toBe(true);
    expect(await readdir(w.paths.generations)).not.toEqual([]);
    expect(await admin.uninstall()).toMatchObject({ outcome: "unchanged" });
  }
}, 120_000);

test("a proxy.routes hostname a Target serves is refused before rigd is replaced, however often install is run", async () => {
  const w = await world();
  await w.config({ tls: { ca: "internal" } });
  await w.admin.install();
  const rigd = await recordedPid(join(w.root, "daemon", "address.json"));
  const token = createHash("sha256").update("app").digest("hex");
  await mkdir(join(w.root, "proxy"), { recursive: true });
  await writeFile(
    w.paths.routes,
    `# rig begin ${token}\napp.example.test {\n  reverse_proxy 127.0.0.1:3001\n}\n# rig end ${token}\n`,
  );
  await w.config({
    tls: { ca: "internal" },
    routes: { "app.example.test": 3999 },
  });
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(w.admin.install()).rejects.toMatchObject({
      code: "ROUTE_CONFLICT",
    });
  expect(await recordedPid(join(w.root, "daemon", "address.json"))).toBe(rigd);
  expect(processExists(rigd)).toBe(true);
  expect(await w.admin.status()).toMatchObject({ reachable: true });
}, 60_000);

test("uninstall removes Rig's Caddy even when the daemon's record is already gone, as an install whose rigd never started leaves it", async () => {
  const w = await world();
  await w.config({ tls: { ca: "internal" } });
  await w.admin.install();
  const caddyPid = await recordedPid(w.paths.processRecord);
  await stopRigd(w.root);
  await rm(join(w.root, "daemon", "install.json"));
  expect(await w.admin.status()).toMatchObject({
    installed: false,
    running: false,
  });
  expect(await w.admin.uninstall()).toMatchObject({ outcome: "uninstalled" });
  expect(processExists(caddyPid)).toBe(false);
  expect(await w.admin.uninstall()).toMatchObject({ outcome: "unchanged" });
}, 60_000);

test("a dashboard address Caddy could not take is published by the next rigd install, which does not report it unchanged", async () => {
  const w = await world();
  const server = join(dashboardDirectory(w.root), "web", "server.js");
  await mkdir(join(server, ".."), { recursive: true });
  await writeFile(server, "");
  const dashboardPort = freePort();
  const configure = (domain: string, https: number) =>
    writeFile(
      join(w.root, "config.yaml"),
      `proxy:\n  caddy: ${caddy}\n  ports: { http: ${w.ports.http}, https: ${https} }\n  tls: { ca: internal }\ndashboard:\n  domain: ${domain}\n  port: ${dashboardPort}\n`,
    );
  const served = async () => {
    const generation = await currentGeneration(w.root);
    return {
      hostnames: generation?.customRoutes.map((route) => route.hostname),
      https: generation?.proxy?.ports.https,
    };
  };
  await configure("dash-a.example.test", w.ports.https);
  expect(await w.admin.install()).toMatchObject({ outcome: "installed" });
  // Another program holds the new HTTPS port, so Caddy refuses the new address and keeps the old one.
  const https = freePort();
  const blocker = Bun.serve({
    hostname: "127.0.0.1",
    port: https,
    fetch: () => new Response(""),
  });
  cleanups.push(async () => blocker.stop(true));
  await configure("dash-b.example.test", https);
  await expect(w.admin.install()).rejects.toBeDefined();
  expect(await served()).toEqual({
    hostnames: ["dash-a.example.test"],
    https: w.ports.https,
  });
  // Once the port is free, the same command publishes the new address and withdraws the old one.
  blocker.stop(true);
  expect(await w.admin.install()).toMatchObject({ outcome: "installed" });
  expect(await served()).toEqual({
    hostnames: ["dash-b.example.test"],
    https,
  });
  expect(await w.admin.install()).toMatchObject({ outcome: "unchanged" });
  // A dashboard taken off its domain is withdrawn the same way.
  await writeFile(
    join(w.root, "config.yaml"),
    `proxy:\n  caddy: ${caddy}\n  ports: { http: ${w.ports.http}, https: ${https} }\n  tls: { ca: internal }\ndashboard:\n  port: ${dashboardPort}\n`,
  );
  expect(await w.admin.install()).toMatchObject({ outcome: "installed" });
  expect(await served()).toEqual({ hostnames: [], https });
}, 120_000);

/** What `hostname` answers on Caddy's HTTPS `port` (internal CA, so unverified): its body, or undefined when nothing does. */
async function through(
  hostname: string,
  port: number,
): Promise<string | undefined> {
  const child = Bun.spawn(
    [
      "/usr/bin/curl",
      "-sk",
      "--max-time",
      "3",
      "--resolve",
      `${hostname}:${port}:127.0.0.1`,
      "-w",
      "\n%{http_code}",
      `https://${hostname}:${port}/`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const lines = (await new Response(child.stdout).text()).split("\n");
  await child.exited;
  return lines.at(-1) === "200" ? lines.slice(0, -1).join("\n") : undefined;
}
async function eventually<T>(
  read: () => Promise<T>,
  wanted: T,
  ms = 30_000,
): Promise<T> {
  let value = await read();
  for (
    const deadline = Date.now() + ms;
    !Bun.deepEquals(value, wanted) && Date.now() < deadline;
    value = await read()
  )
    await Bun.sleep(250);
  return value;
}

test("after a rigd install whose new dashboard address Caddy refused, the running dashboard keeps the address Caddy serves; the next install moves both", async () => {
  if (!caddy)
    throw new Error("Proxy installation tests require a local caddy.");
  // Source rig and rigd, with the real dashboard supervisor: the dashboard answers with the address it admits.
  const f = await rigFixture();
  cleanups.push(() => f.cleanup());
  const server = join(dashboardDirectory(f.root), "web", "server.js");
  await mkdir(join(server, ".."), { recursive: true });
  await writeFile(
    server,
    `Bun.serve({ port: Number(process.env.PORT), hostname: process.env.HOSTNAME, fetch: () => new Response(process.env.RIG_WEB_DASHBOARD_HOST ?? "unpublished") });`,
  );
  const http = freePort();
  const dashboard = freePort();
  const configure = (domain: string, https: number) =>
    writeFile(
      join(f.root, "config.yaml"),
      `proxy:\n  caddy: ${caddy}\n  ports: { http: ${http}, https: ${https} }\n  tls: { ca: internal }\ndashboard:\n  domain: ${domain}\n  port: ${dashboard}\n`,
    );
  const local = () =>
    fetch(`http://127.0.0.1:${dashboard}/`)
      .then((response) => response.text())
      .catch(() => undefined);
  const a = { domain: "dash-a.example.test", https: freePort() };
  await configure(a.domain, a.https);
  expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
  const atA = `${a.domain}:${a.https}`;
  expect(await eventually(() => through(a.domain, a.https), atA)).toBe(atA);

  // Another program holds the new HTTPS port, so Caddy refuses the new address.
  const b = { domain: "dash-b.example.test", https: freePort() };
  const blocker = Bun.serve({
    hostname: "127.0.0.1",
    port: b.https,
    fetch: () => new Response("another program"),
  });
  cleanups.push(async () => blocker.stop(true));
  const before = await recordedPid(join(f.root, "daemon", "address.json"));
  await configure(b.domain, b.https);
  expect((await f.rigd(["install"])).code).not.toBe(0);
  // A new rigd runs, and its dashboard admits the address Caddy still serves it at, not the refused one.
  expect(await recordedPid(join(f.root, "daemon", "address.json"))).not.toBe(
    before,
  );
  expect(await eventually(local, atA)).toBe(atA);
  expect(await eventually(() => through(a.domain, a.https), atA)).toBe(atA);
  // rigd status says the address is held, and how to apply Host config's.
  const status = await f.rigd(["status"]);
  expect(status.stdout + status.stderr).toContain(
    `Dashboard: It is published at https://${atA}, the address Rig's Caddy accepted; Host config asks for https://${b.domain}:${b.https}, which Caddy has not taken. Run rigd install to apply it.`,
  );

  // Once the port is free, the same command moves Caddy and the dashboard together.
  blocker.stop(true);
  expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
  const atB = `${b.domain}:${b.https}`;
  expect(await eventually(local, atB)).toBe(atB);
  expect(await eventually(() => through(b.domain, b.https), atB)).toBe(atB);
  expect(await through(a.domain, a.https)).toBeUndefined();
  expect((await f.rigd(["install"])).stdout).toContain("unchanged");
}, 180_000);

/** A source Rig root whose dashboard answers with the address it admits, configured by `configure(domain, https)`. */
async function dashboardRoot(
  setup: (root: string) => Promise<void> = async () => {},
) {
  const f = await rigFixture();
  cleanups.push(() => f.cleanup());
  await setup(f.root);
  const server = join(dashboardDirectory(f.root), "web", "server.js");
  await mkdir(join(server, ".."), { recursive: true });
  await writeFile(
    server,
    `Bun.serve({ port: Number(process.env.PORT), hostname: process.env.HOSTNAME, fetch: () => new Response(process.env.RIG_WEB_DASHBOARD_HOST ?? "unpublished") });`,
  );
  const http = freePort();
  const port = freePort();
  return {
    f,
    configure: (domain: string, https: number, extra = "") =>
      writeFile(
        join(f.root, "config.yaml"),
        `${extra}proxy:\n  caddy: ${caddy}\n  ports: { http: ${http}, https: ${https} }\n  tls: { ca: internal }\ndashboard:\n  domain: ${domain}\n  port: ${port}\n`,
      ),
    local: () =>
      fetch(`http://127.0.0.1:${port}/`)
        .then((response) => response.text())
        .catch(() => undefined),
  };
}
/** Holds `port` the way another program would, until the test ends or `stop`. */
function hold(port: number) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response("another program"),
  });
  cleanups.push(async () => server.stop(true));
  return server;
}

test("a dashboard address Host config moved to while rigd was stopped is published by rigd's start, however an earlier install failed", async () => {
  if (!caddy)
    throw new Error("Proxy installation tests require a local caddy.");
  const w = await dashboardRoot();
  const a = { domain: "dash-a.example.test", https: freePort() };
  await w.configure(a.domain, a.https);
  expect(await w.f.rigd(["install"])).toMatchObject({ code: 0 });
  const atA = `${a.domain}:${a.https}`;
  expect(await eventually(w.local, atA)).toBe(atA);
  // A failed move, then Host config back as it was: install has nothing to do.
  const b = { domain: "dash-b.example.test", https: freePort() };
  const blocker = hold(b.https);
  await w.configure(b.domain, b.https);
  expect((await w.f.rigd(["install"])).code).not.toBe(0);
  const asksForB = async () => {
    const status = await w.f.rigd(["status"]);
    return (status.stdout + status.stderr).includes(
      `Host config asks for https://${b.domain}:${b.https}`,
    );
  };
  expect(await eventually(asksForB, true)).toBe(true);
  blocker.stop(true);
  await w.configure(a.domain, a.https);
  expect(await w.f.rigd(["install"])).toMatchObject({ code: 0 });
  expect(await eventually(w.local, atA)).toBe(atA);
  // Host config asks for the address the dashboard is held at again, so rigd status names no move.
  const status = await w.f.rigd(["status"]);
  expect(status.stdout + status.stderr).not.toContain("Host config asks for");
  // rigd stops, Host config moves to a free address, and rigd starts on its own (a reboot): it publishes the new address,
  // and its dashboard admits it, rather than anything an earlier failure left.
  await stopRigd(w.f.root);
  const c = { domain: "dash-c.example.test", https: freePort() };
  await w.configure(c.domain, c.https);
  const rigd = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "src", "rigd.ts")],
    {
      env: { ...process.env, RIG_ROOT: w.f.root, RIG_DAEMON_CHILD: "1" },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  cleanups.push(async () => {
    rigd.kill();
    await rigd.exited;
  });
  const atC = `${c.domain}:${c.https}`;
  expect(await eventually(w.local, atC)).toBe(atC);
  expect(await eventually(() => through(c.domain, c.https), atC)).toBe(atC);
}, 180_000);

test("after a boot-mode rigd install whose new dashboard address Caddy refused, the system rigd's dashboard keeps the address Caddy serves; the next install moves both", async () => {
  if (!caddy)
    throw new Error("Proxy installation tests require a local caddy.");
  // launchd is faked: the system jobs' plists go to a temporary directory, and their program is started here as launchd
  // would, again whenever it exits. Rig's Caddy runs as a detached process (tests/support/system-rigd.ts).
  const places = { staging: "", daemons: "" };
  const w = await dashboardRoot(async (root) => {
    places.staging = join(root, "staging");
    places.daemons = join(root, "LaunchDaemons");
    await mkdir(places.daemons, { recursive: true });
  });
  const root = w.f.root;
  const home = join(w.f.base, "home");
  await mkdir(home, { recursive: true });
  const program = join(import.meta.dir, "support", "system-rigd.ts");
  let loaded = false;
  const proxy = createProxyInstallation({
    root,
    userHome: home,
    uid: process.getuid!(),
    userName: "test",
    mode: "process",
    run: runCommand,
    startDeadlineMs: 8000,
  });
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, program],
    mode: "launchd",
    userHome: home,
    uid: process.getuid!(),
    userName: "test",
    start: async () => "boot",
    dashboard: async () => dashboardServing(root, await readHostConfig(root)),
    systemPlaces: places,
    proxy,
    launchctl: async (args) => ({
      code: args[0] === "print" && !loaded ? 113 : 0,
      stderr: "",
    }),
  });
  let running: ReturnType<typeof Bun.spawn> | undefined;
  let keepAlive = true;
  cleanups.push(async () => {
    keepAlive = false;
    running?.kill();
    await running?.exited;
    await proxy.remove();
  });
  const a = { domain: "dash-a.example.test", https: freePort() };
  await w.configure(a.domain, a.https, "daemon: { start: boot }\n");
  const pending = await admin.install().catch((error) => error);
  expect(pending).toMatchObject({ code: "DAEMON_SYSTEM_INSTALL" });
  // The owner's sudo lines: both plists installed, and launchd runs them.
  for (const line of pending.details.commands as string[]) {
    const label =
      /bootstrap system '.*\/(com\.b-relay\.[a-z-]+\.[0-9a-f]+)\.plist'/.exec(
        line,
      )![1]!;
    await writeFile(
      join(places.daemons, `${label}.plist`),
      await readFile(join(root, "daemon", "launchd", `${label}.plist`)),
    );
  }
  loaded = true;
  await createProcessCaddyJob({
    root,
    paths: proxyPaths(root),
    userHome: home,
    admin: createCaddyAdmin(proxyPaths(root).socket),
  }).install();
  void (async () => {
    while (keepAlive) {
      running = Bun.spawn([process.execPath, program], {
        env: {
          ...process.env,
          RIG_ROOT: root,
          RIG_DAEMON_CHILD: "1",
          RIG_DAEMON_MODE: "system",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      await running.exited;
      await Bun.sleep(100);
    }
  })();
  expect(
    await eventually(async () => (await admin.status()).reachable, true),
  ).toBe(true);
  expect(await admin.install()).toMatchObject({ reachable: true });
  const atA = `${a.domain}:${a.https}`;
  expect(await eventually(() => through(a.domain, a.https), atA)).toBe(atA);

  // Another program holds the new HTTPS port: the install fails, and the system rigd it restarted admits the address
  // Caddy still serves it at.
  const b = { domain: "dash-b.example.test", https: freePort() };
  const blocker = hold(b.https);
  await w.configure(b.domain, b.https, "daemon: { start: boot }\n");
  await expect(admin.install()).rejects.toBeDefined();
  expect(await eventually(w.local, atA)).toBe(atA);
  expect(await eventually(() => through(a.domain, a.https), atA)).toBe(atA);
  expect(await through(b.domain, a.https)).toBeUndefined();

  // Once the port is free, the next install moves both.
  blocker.stop(true);
  await admin.install();
  const atB = `${b.domain}:${b.https}`;
  expect(await eventually(w.local, atB)).toBe(atB);
  expect(await eventually(() => through(b.domain, b.https), atB)).toBe(atB);
  expect(await admin.install()).toMatchObject({ outcome: "unchanged" });
}, 180_000);

test("a rigd that cannot confirm what Caddy serves after an unclean stop starts no dashboard until it can, then admits the address Caddy serves", async () => {
  if (!caddy)
    throw new Error("Proxy installation tests require a local caddy.");
  const root = await mkdtemp("/tmp/rig-pi-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const paths = proxyPaths(root);
  const caddyAdmin = createCaddyAdmin(paths.socket);
  const job = createProcessCaddyJob({
    root,
    paths,
    userHome: home,
    admin: caddyAdmin,
  });
  cleanups.push(() => job.remove());
  const installation = createProxyInstallation({
    root,
    userHome: home,
    uid: process.getuid!(),
    userName: "test",
    mode: "process",
    run: runCommand,
    startDeadlineMs: 8000,
  });
  const server = join(dashboardDirectory(root), "web", "server.js");
  await mkdir(join(server, ".."), { recursive: true });
  await writeFile(
    server,
    `Bun.serve({ port: Number(process.env.PORT), hostname: process.env.HOSTNAME, fetch: () => new Response(process.env.RIG_WEB_DASHBOARD_HOST ?? "unpublished") });`,
  );
  const http = freePort();
  const port = freePort();
  const a = { domain: "dash-a.example.test", https: freePort() };
  const b = { domain: "dash-b.example.test", https: freePort() };
  const configure = (domain: string, https: number) =>
    writeFile(
      join(root, "config.yaml"),
      `proxy:\n  caddy: ${caddy}\n  ports: { http: ${http}, https: ${https} }\n  tls: { ca: internal }\ndashboard:\n  domain: ${domain}\n  port: ${port}\n`,
    );
  const local = () =>
    fetch(`http://127.0.0.1:${port}/`)
      .then((response) => response.text())
      .catch(() => undefined);

  // An earlier rigd served A, its dashboard found on its port.
  await configure(a.domain, a.https);
  await installation.install();
  const earlier = Bun.spawn([process.execPath, server], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      RIG_WEB_DASHBOARD_HOST: `${a.domain}:${a.https}`,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await eventually(local, `${a.domain}:${a.https}`)).toBe(
    `${a.domain}:${a.https}`,
  );
  const routeA = { domain: a.domain, port };
  const publisher = createManagedCaddy({
    root,
    settings: async () => (await readHostConfig(root)).proxy!,
    dashboard: { current: () => routeA, confirmed: async () => routeA },
    run: runCommand,
    job,
    admin: caddyAdmin,
  });
  await publisher.republish();
  const servedA = await currentGeneration(root);
  await publisher.close();
  earlier.kill();
  await earlier.exited;
  // Then B was switched to, and the rigd ended before Caddy loaded it (#696's crash boundary): `current` names B, Caddy
  // runs A, and no clean stop was recorded. The restart that recovery needs is refused, and no dashboard is left running.
  await configure(b.domain, b.https);
  await installation.install();
  expect(await caddyAdmin.load(servedA!.adapted)).toBeUndefined();
  await rm(paths.cleanStop, { force: true });
  await writeFile(join(root, "refuse-caddy-restart"), "");
  // The credential rigd install would have issued.
  await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "auth", "control-plane.token"), "t".repeat(43), {
    mode: 0o600,
  });
  const rigd = Bun.spawn(
    [process.execPath, join(import.meta.dir, "support", "system-rigd.ts")],
    {
      env: {
        ...process.env,
        RIG_ROOT: root,
        RIG_DAEMON_CHILD: "1",
        RIG_DAEMON_MODE: "system",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  cleanups.push(async () => {
    rigd.kill();
    await rigd.exited;
  });
  const status = new DaemonAdmin({
    root,
    command: [process.execPath],
    mode: "process",
    userHome: home,
  });
  const waiting = async () =>
    ((await status.status()).warnings ?? []).some((warning) =>
      warning.includes(
        "not started until rigd confirms what Rig's Caddy serves",
      ),
    );
  expect(await eventually(waiting, true)).toBe(true);
  // Nothing admits B while Caddy still serves A.
  expect(await local()).toBeUndefined();
  expect(Bun.deepEquals(await caddyAdmin.config(), servedA!.adapted)).toBe(
    true,
  );
  // Once the restart is allowed, recovery serves the current generation, and the dashboard admits its address.
  await rm(join(root, "refuse-caddy-restart"));
  const atB = `${b.domain}:${b.https}`;
  expect(await eventually(local, atB, 60_000)).toBe(atB);
  expect(await eventually(() => through(b.domain, b.https), atB)).toBe(atB);
  expect(await through(a.domain, a.https)).toBeUndefined();
}, 180_000);

test("rigd uninstall stops a rigd whose recovery restart of Caddy is still waiting, for the new process or the old one's exit, within the stop deadline, and no clean stop is recorded", async () => {
  if (!caddy)
    throw new Error("Proxy installation tests require a local caddy.");
  // new: the restarted Caddy never answers. old: the running Caddy does not exit when asked (tests/support/system-rigd.ts).
  for (const stall of ["old", "new"] as const) {
    const root = await mkdtemp("/tmp/rig-pi-");
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const paths = proxyPaths(root);
    const installation = createProxyInstallation({
      root,
      userHome: home,
      uid: process.getuid!(),
      userName: "test",
      mode: "process",
      run: runCommand,
      startDeadlineMs: 8000,
    });
    cleanups.push(() => installation.remove());
    await writeFile(
      join(root, "config.yaml"),
      `proxy:\n  caddy: ${caddy}\n  ports: { http: ${freePort()}, https: ${freePort()} }\n  tls: { ca: internal }\n`,
    );
    await installation.install();
    // An earlier rigd's unclean stop: the next rigd restarts Caddy before it trusts it, and that restart waits.
    await rm(paths.cleanStop, { force: true });
    await writeFile(
      join(root, stall === "new" ? "hold-caddy-restart" : "ignore-caddy-stop"),
      "",
    );
    const caddyPid = await recordedPid(paths.processRecord);
    await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "auth", "control-plane.token"), "t".repeat(43), {
      mode: 0o600,
    });
    const rigd = Bun.spawn(
      [process.execPath, join(import.meta.dir, "support", "system-rigd.ts")],
      {
        env: {
          ...process.env,
          RIG_ROOT: root,
          RIG_DAEMON_CHILD: "1",
          RIG_DAEMON_MODE: "system",
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    cleanups.push(async () => {
      rigd.kill();
      await rigd.exited;
    });
    const admin = new DaemonAdmin({
      root,
      command: [process.execPath],
      mode: "process",
      userHome: home,
      launchctl: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(
      await eventually(
        async () =>
          existsSync(
            join(
              root,
              stall === "new" ? "caddy-restart-held" : "caddy-stop-ignored",
            ),
          ),
        true,
      ),
    ).toBe(true);
    expect(await admin.status()).toMatchObject({ reachable: true });
    const started = Date.now();
    expect(await admin.uninstall()).toMatchObject({ outcome: "uninstalled" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(processExists(rigd.pid)).toBe(false);
    // The restart was cut short, so this rigd cannot vouch for what Caddy holds: the next one restarts it first.
    expect(existsSync(paths.cleanStop)).toBe(false);
    expect(existsSync(paths.restore)).toBe(true);
    // Cut short before the old process exited, it is still recorded, so the next rigd finds and restarts it; no new one was
    // started.
    if (stall === "old") {
      expect(await recordedPid(paths.processRecord)).toBe(caddyPid);
      expect(processExists(caddyPid)).toBe(true);
    }
  }
}, 180_000);
