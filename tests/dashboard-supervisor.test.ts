import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DASHBOARD,
  configuredDashboardRoute,
  publishedProxySettings,
  dashboardCheck,
  dashboardPublication,
  describeDashboard,
  withDashboardRoute,
  dashboardDirectory,
  dashboardServing,
  openDashboard,
  stopLeftOverDashboard,
  type DashboardDependencies,
} from "../src/daemon/dashboard";
import { waitForLogPoll } from "../src/adapters/log-follow-scheduler";
import { parseHostConfig } from "../src/config/schema";
import { hostRoutes, proxyPaths } from "../src/domain/managed-proxy";
import { createProxyInstallation } from "../src/daemon/proxy-installation";
import { runCommand } from "../src/providers/command-runner";
import { createListenerInspection } from "../src/providers/listener-inspection";
import { probeLocalPort } from "../src/providers/port-probe";
import { pendingSettings } from "../src/adapters/proxy-generation";
import { accessPolicy } from "../web/server/guard";
import {
  processExists,
  processStartTime,
} from "../src/daemon/process-identity";
import { DEFAULT_LOG_RETENTION } from "../src/domain/log-retention";
import { startControlPlane } from "../src/daemon/server";
import { DaemonClient } from "../src/daemon/client";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** A port nothing listens on now. */
function freePort(): number {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = probe.port!;
  probe.stop(true);
  return port;
}
/** A Rig root with an installed dashboard whose server.js is `server`, run as rigd runs it. */
async function installed(server: string) {
  const root = await mkdtemp(join(tmpdir(), "rig-dashboard-"));
  roots.push(root);
  const directory = dashboardDirectory(root);
  await mkdir(join(directory, "web"), { recursive: true });
  await writeFile(join(directory, "web", "server.js"), server);
  const notes: string[] = [];
  const cleared: string[] = [];
  const waits: number[] = [];
  /** Each change of whether Caddy may route to the dashboard, as rigd was told it. */
  const serving: boolean[] = [];
  const deps: DashboardDependencies = {
    root,
    port: freePort(),
    directory,
    // Bun runs the tests, as it runs rigd from source.
    executable: process.execPath,
    retention: async () => DEFAULT_LOG_RETENTION,
    notices: {
      note: (channel, message) => notes.push(`${channel.name}: ${message}`),
      clear: (channel) => cleared.push(channel.name),
    },
    listeners: createListenerInspection(runCommand),
    portTaken: async (port) =>
      (await probeLocalPort(port, AbortSignal.timeout(3000))).ready,
    serving: async (listening) => void serving.push(listening),
    wait: async (ms) => void waits.push(ms),
    now: Date.now,
  };
  return { root, directory, deps, notes, cleared, waits, serving };
}
/** A server that answers with its own pid on PORT and HOSTNAME, as Next.js's standalone server reads them. */
const SERVER = `
console.log("dashboard ready");
Bun.serve({
  port: Number(process.env.PORT),
  hostname: process.env.HOSTNAME,
  fetch: () => new Response(String(process.pid)),
});
`;
async function answer(
  url: string,
  attempts = 100,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const reply = await fetch(url).then(
      (response) => response.text(),
      () => undefined,
    );
    if (reply !== undefined) return reply;
    await Bun.sleep(50);
  }
  return undefined;
}

test("without a dashboard installed for this release, there is none to run", async () => {
  const f = await installed(SERVER);
  await rm(join(f.directory, "web", "server.js"));
  expect(await openDashboard(f.deps)).toBeUndefined();
});

test("rigd serves the installed dashboard on 127.0.0.1 at its port, records its output, and stops it with itself", async () => {
  const f = await installed(SERVER);
  const dashboard = (await openDashboard(f.deps))!;
  expect(dashboard.url).toBe(`http://127.0.0.1:${f.deps.port}`);
  dashboard.start();
  const pid = Number(await answer(dashboard.url));
  expect(processExists(pid)).toBe(true);
  // Recorded with its start time, so a later rigd can stop this very process.
  expect(
    JSON.parse(
      await readFile(join(f.root, "dashboard", "process.json"), "utf8"),
    ),
  ).toEqual({
    pid,
    startedAt: await processStartTime(pid),
  });
  await dashboard.stop();
  expect(processExists(pid)).toBe(false);
  expect(
    await fetch(dashboard.url).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(
    await readFile(join(f.root, "logs", "dashboard", "dashboard.log"), "utf8"),
  ).toContain("dashboard ready");
  await expect(
    stat(join(f.root, "dashboard", "process.json")),
  ).rejects.toThrow();
  expect(f.notes).toEqual([]);
});

/** Resolves once `ready` holds, polling for up to five seconds; false when it never did. */
async function until(ready: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100 && !ready(); attempt++)
    await Bun.sleep(50);
  return ready();
}

test("Caddy may route to the dashboard only once its own process holds 127.0.0.1:<port>, and not from before a stop or once it ends", async () => {
  const f = await installed(SERVER);
  /** Whether the dashboard's process answered on its address as rigd was told each change. */
  const answered: boolean[] = [];
  const dashboard = (await openDashboard({
    ...f.deps,
    wait: (_ms, signal) => waitForLogPoll(50, signal),
    serving: async (listening) => {
      f.serving.push(listening);
      answered.push(
        (await answer(`http://127.0.0.1:${f.deps.port}`, 1)) !== undefined,
      );
    },
  }))!;
  expect(dashboard.problem()).toBeUndefined();
  dashboard.start();
  const pid = Number(await answer(dashboard.url));
  expect(await until(() => f.serving.length === 1)).toBe(true);
  expect(f.serving).toEqual([true]);

  // It ends on its own: withheld, then served again once its replacement is confirmed.
  process.kill(pid, "SIGKILL");
  expect(await until(() => f.serving.length === 3)).toBe(true);
  // A stop withholds it while the process still runs.
  await dashboard.stop();
  expect(f.serving).toEqual([true, false, true, false]);
  expect(answered).toEqual([true, false, true, true]);
});

test("a port another program holds is never routed: the dashboard is withheld, and the notice says that program holds the port", async () => {
  const f = await installed(SERVER);
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: f.deps.port,
    fetch: () => new Response("another program"),
  });
  const dashboard = (await openDashboard({
    ...f.deps,
    wait: (ms, signal) => {
      f.waits.push(ms);
      return waitForLogPoll(100, signal);
    },
  }))!;
  dashboard.start();
  expect(await until(() => f.notes.length > 0)).toBe(true);
  expect(f.notes[0]).toBe(
    `${DASHBOARD.name}: The dashboard exited with code 1: another program holds port ${f.deps.port}; rigd starts it again in 1 s.`,
  );
  expect(dashboard.problem()).toBe(f.notes.at(-1)!.slice("dashboard: ".length));
  expect(f.serving).toEqual([]);

  // Once the port is free, the next start holds it and is served.
  other.stop(true);
  expect(await until(() => f.serving.length === 1)).toBe(true);
  expect(dashboard.problem()).toBeUndefined();
  await dashboard.stop();
  expect(f.serving).toEqual([true, false]);
});

test("a dashboard that answers somewhere other than 127.0.0.1 is never routed, while another program holds 127.0.0.1 at its port", async () => {
  const f = await installed(`
Bun.serve({ port: Number(process.env.PORT), hostname: "::1", fetch: () => new Response("dashboard") });
`);
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: f.deps.port,
    fetch: () => new Response("another program"),
  });
  try {
    const dashboard = (await openDashboard(f.deps))!;
    dashboard.start();
    expect(await answer(`http://[::1]:${f.deps.port}`)).toBe("dashboard");
    await Bun.sleep(1500);
    expect(f.serving).toEqual([]);
    await dashboard.stop();
    expect(f.serving).toEqual([]);
  } finally {
    other.stop(true);
  }
});

test("a dashboard that exits is started again after a back-off that doubles while it keeps exiting, and doctor hears of it", async () => {
  // Exits with code 3 twice, then serves.
  const f = await installed(`
const counter = ${JSON.stringify(join(tmpdir(), `rig-dashboard-runs-${process.pid}-${Date.now()}`))};
const fs = require("node:fs");
const runs = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(runs + 1));
if (runs < 2) process.exit(3);
${SERVER}`);
  const dashboard = (await openDashboard(f.deps))!;
  dashboard.start();
  expect(await answer(dashboard.url)).toBeDefined();
  await dashboard.stop();
  expect(f.waits).toEqual([1000, 2000]);
  expect(f.notes).toEqual([
    `${DASHBOARD.name}: The dashboard exited with code 3; rigd starts it again in 1 s.`,
    `${DASHBOARD.name}: The dashboard exited with code 3; rigd starts it again in 2 s.`,
  ]);
  expect(
    await readFile(join(f.root, "logs", "dashboard", "dashboard.log"), "utf8"),
  ).toContain(
    "[rigd] The dashboard exited with code 3; rigd starts it again in 1 s.",
  );
});

test("a dashboard an earlier rigd left running is stopped before this one starts, so the port is free", async () => {
  const f = await installed(SERVER);
  // What a rigd that was killed leaves: its dashboard serving, and the record of it.
  const left = Bun.spawn([process.execPath, "server.js"], {
    cwd: join(f.directory, "web"),
    env: { ...process.env, PORT: String(f.deps.port), HOSTNAME: "127.0.0.1" },
    stdout: "ignore",
  });
  expect(await answer(`http://127.0.0.1:${f.deps.port}`)).toBe(
    String(left.pid),
  );
  await writeFile(
    join(f.root, "dashboard", "process.json"),
    JSON.stringify({
      pid: left.pid,
      startedAt: await processStartTime(left.pid),
    }),
  );
  await stopLeftOverDashboard(f.root);
  await left.exited;
  const dashboard = (await openDashboard(f.deps))!;
  dashboard.start();
  const pid = await answer(dashboard.url);
  expect(pid).not.toBe(String(left.pid));
  await dashboard.stop();
  expect(f.notes).toEqual([]);
});

test("a recorded process that is not the one recorded (its pid reused) is left alone", async () => {
  const f = await installed(SERVER);
  const other = Bun.spawn(["/bin/sleep", "30"]);
  await writeFile(
    join(f.root, "dashboard", "process.json"),
    JSON.stringify({ pid: other.pid, startedAt: "Mon Jan  1 00:00:00 2001" }),
  );
  await stopLeftOverDashboard(f.root);
  expect(processExists(other.pid)).toBe(true);
  const dashboard = (await openDashboard(f.deps))!;
  dashboard.start();
  expect(await answer(dashboard.url)).toBeDefined();
  await dashboard.stop();
  other.kill();
});

test("rigd's health reply names where it serves the dashboard, and omits it when it serves none", async () => {
  for (const dashboard of ["http://127.0.0.1:4280", undefined]) {
    const server = startControlPlane({
      port: 0,
      token: "test",
      instanceId: "dashboard",
      handle: async () => ({}),
      ...(dashboard ? { dashboard } : {}),
    });
    try {
      const health = await new DaemonClient({
        port: server.port!,
        token: "test",
      }).health();
      expect(health.dashboard).toBe(dashboard);
    } finally {
      server.stop(true);
    }
  }
});

test("a left-over dashboard is stopped even when this rigd serves none, and a record that is not one is cleared without stopping anything", async () => {
  const f = await installed(SERVER);
  const left = Bun.spawn([process.execPath, "server.js"], {
    cwd: join(f.directory, "web"),
    env: { ...process.env, PORT: String(f.deps.port), HOSTNAME: "127.0.0.1" },
    stdout: "ignore",
  });
  await answer(`http://127.0.0.1:${f.deps.port}`);
  await writeFile(
    join(f.root, "dashboard", "process.json"),
    JSON.stringify({
      pid: left.pid,
      startedAt: await processStartTime(left.pid),
    }),
  );
  // This release's dashboard is gone, or Host config turned it off: rigd opens none, and still stops the left-over one.
  await rm(join(f.directory, "web", "server.js"));
  expect(await openDashboard(f.deps)).toBeUndefined();
  await stopLeftOverDashboard(f.root);
  await left.exited;
  await expect(
    stat(join(f.root, "dashboard", "process.json")),
  ).rejects.toThrow();
  // A record that is not one (torn by a crash, null, or of the wrong types) is removed, and nothing is signalled.
  for (const text of [
    '{"pid": 1',
    "null",
    "[]",
    '{"pid": "1", "startedAt": 5}',
    '{"pid": 1}',
  ]) {
    await writeFile(join(f.root, "dashboard", "process.json"), text);
    await stopLeftOverDashboard(f.root);
    await expect(
      stat(join(f.root, "dashboard", "process.json")),
    ).rejects.toThrow();
  }
});

test("a stop right after a start that could not spawn the dashboard returns, rather than waiting for an exit that never comes", async () => {
  const f = await installed(SERVER);
  const dashboard = (await openDashboard({
    ...f.deps,
    executable: join(f.root, "no-such-executable"),
  }))!;
  dashboard.start();
  const stopped = await Promise.race([
    dashboard.stop().then(() => "stopped"),
    Bun.sleep(3000).then(() => "hung"),
  ]);
  expect(stopped).toBe("stopped");
});

test("a dashboard whose process cannot be recorded is stopped rather than left running unrecorded, and doctor hears why", async () => {
  const f = await installed(SERVER);
  // The record's directory cannot be written.
  await chmod(join(f.root, "dashboard"), 0o500);
  try {
    const dashboard = (await openDashboard(f.deps))!;
    dashboard.start();
    for (let attempt = 0; attempt < 100 && f.notes.length === 0; attempt++)
      await Bun.sleep(50);
    await dashboard.stop();
    expect(f.notes[0]).toContain(
      `The dashboard could not be recorded in ${join(f.root, "dashboard", "process.json")}, so it was stopped; rigd starts it again in 1 s.`,
    );
    expect(
      await fetch(dashboard.url).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await chmod(join(f.root, "dashboard"), 0o700);
  }
});

test("a stop during the back-off ends the wait at once", async () => {
  const f = await installed("process.exit(3);");
  const dashboard = (await openDashboard({ ...f.deps, wait: waitForLogPoll }))!;
  dashboard.start();
  for (let attempt = 0; attempt < 100 && f.notes.length === 0; attempt++)
    await Bun.sleep(20);
  const began = Date.now();
  await dashboard.stop();
  // The first back-off is a second; the stop does not sit it out.
  expect(Date.now() - began).toBeLessThan(800);
});

test("the back-off doubles up to a minute while it keeps exiting, and starts over after a steady minute", async () => {
  const f = await installed("process.exit(3);");
  // Each start and exit reads the clock; the seventh run counts as having run steadily for a minute.
  let clock = 0;
  let reads = 0;
  const dashboard = (await openDashboard({
    ...f.deps,
    now: () => {
      reads++;
      if (reads === 16) clock += 61_000;
      return clock;
    },
  }))!;
  dashboard.start();
  for (let attempt = 0; attempt < 200 && f.waits.length < 9; attempt++)
    await Bun.sleep(20);
  await dashboard.stop();
  expect(f.waits.slice(0, 9)).toEqual([
    1000, 2000, 4000, 8000, 16000, 32000, 60000, 1000, 2000,
  ]);
});

test("the dashboard's log is rotated by the Host's log sizes", async () => {
  // A kilobyte of output, then an exit, which rigd's own line about the restart follows in the log.
  const f = await installed("console.log('x'.repeat(1000)); process.exit(3);");
  const dashboard = (await openDashboard({
    ...f.deps,
    retention: async () => ({ maxBytes: 300, generations: 1 }),
  }))!;
  dashboard.start();
  for (let attempt = 0; attempt < 100 && f.notes.length === 0; attempt++)
    await Bun.sleep(20);
  await dashboard.stop();
  const logs = join(f.root, "logs", "dashboard");
  expect((await stat(join(logs, "dashboard.log.1"))).size).toBeGreaterThan(0);
  expect(await readFile(join(logs, "dashboard.log"), "utf8")).toContain(
    "[rigd] The dashboard exited with code 3",
  );
});

test("rigd install restarts rigd when it would serve the dashboard elsewhere: on another port, off, or not installed", async () => {
  const f = await installed(SERVER);
  expect(await dashboardServing(f.root, parseHostConfig({}))).toBe(
    "http://127.0.0.1:4280",
  );
  expect(
    await dashboardServing(
      f.root,
      parseHostConfig({ dashboard: { port: 5001 } }),
    ),
  ).toBe("http://127.0.0.1:5001");
  expect(
    await dashboardServing(f.root, parseHostConfig({ dashboard: false })),
  ).toBeUndefined();
  await rm(join(f.directory, "web", "server.js"));
  expect(await dashboardServing(f.root, parseHostConfig({}))).toBeUndefined();
});

test("how the dashboard is served reads its local address, and where Caddy publishes it with whom it trusts", async () => {
  expect(describeDashboard(4280)).toBe("http://127.0.0.1:4280");
  expect(
    describeDashboard(4280, {
      domain: "rig.example.com",
      authority: "rig.example.com",
      trustedClients: [],
    }),
  ).toBe("https://rig.example.com via http://127.0.0.1:4280");
  expect(
    describeDashboard(4280, {
      domain: "rig.example.com",
      authority: "rig.example.com",
      trustedClients: ["100.64.0.0/10", "192.168.1.5"],
    }),
  ).toBe(
    "https://rig.example.com via http://127.0.0.1:4280, trusting 100.64.0.0/10, 192.168.1.5",
  );
  // So rigd install restarts rigd when the domain or the trusted clients change, as for the port.
  const f = await installed(SERVER);
  const proxy = { caddy: "/usr/local/bin/caddy" };
  expect(
    await dashboardServing(
      f.root,
      parseHostConfig({
        proxy,
        dashboard: {
          domain: "rig.example.com",
          trusted_clients: ["100.64.0.0/10"],
        },
      }),
    ),
  ).toBe(
    "https://rig.example.com via http://127.0.0.1:4280, trusting 100.64.0.0/10",
  );
});

test("a published dashboard runs with its host, its access key file, and the clients it trusts; one on this Mac only with its access key file alone", async () => {
  const f = await installed(`
Bun.serve({
  port: Number(process.env.PORT),
  hostname: process.env.HOSTNAME,
  fetch: () => Response.json({
    host: process.env.RIG_WEB_HOST ?? null,
    dashboard: process.env.RIG_WEB_DASHBOARD_HOST ?? null,
    key: process.env.RIG_WEB_KEY_FILE ?? null,
    trusted: process.env.RIG_WEB_TRUSTED_CLIENTS ?? null,
  }),
});`);
  const published = (await openDashboard({
    ...f.deps,
    published: {
      domain: "rig.example.com",
      authority: "rig.example.com",
      trustedClients: ["100.64.0.0/10", "192.168.1.5"],
    },
  }))!;
  expect(published.serving).toBe(
    `https://rig.example.com via ${published.url}, trusting 100.64.0.0/10, 192.168.1.5`,
  );
  published.start();
  expect(JSON.parse((await answer(published.url))!)).toEqual({
    host: "rig.example.com",
    dashboard: "rig.example.com",
    key: join(f.root, "auth", "dashboard.key"),
    trusted: "100.64.0.0/10,192.168.1.5",
  });
  await published.stop();
  const local = (await openDashboard(f.deps))!;
  local.start();
  expect(JSON.parse((await answer(local.url))!)).toEqual({
    host: null,
    dashboard: null,
    key: join(f.root, "auth", "dashboard.key"),
    trusted: null,
  });
  await local.stop();
});

test("Caddy is given the dashboard's route only when a dashboard is installed, on, and published, to the port it serves", async () => {
  const f = await installed(SERVER);
  const proxy = {
    caddy: "/usr/local/bin/caddy",
    routes: { "grafana.example.com": 3000 },
  };
  const host = (dashboard: unknown) => parseHostConfig({ proxy, dashboard });
  const route = await configuredDashboardRoute(
    f.root,
    host({ port: 4281, domain: "rig.example.com" }),
  );
  expect(route).toEqual({ domain: "rig.example.com", port: 4281, https: 443 });
  expect(hostRoutes(withDashboardRoute(host({}).proxy!, route))).toEqual([
    { hostname: "grafana.example.com", upstream: "127.0.0.1:3000" },
    { hostname: "rig.example.com", upstream: "127.0.0.1:4281" },
  ]);
  // Off, or not published: no route.
  expect(await configuredDashboardRoute(f.root, host(false))).toBeUndefined();
  expect(await configuredDashboardRoute(f.root, host({}))).toBeUndefined();
  expect(withDashboardRoute(host({}).proxy!, undefined).routes).toEqual({
    "grafana.example.com": 3000,
  });
  // Not installed for this release: nothing would answer on its port, so Caddy sends nobody there.
  await rm(join(f.directory, "web", "server.js"));
  expect(
    await configuredDashboardRoute(f.root, host({ domain: "rig.example.com" })),
  ).toBeUndefined();
});

test("rigd install refuses a dashboard.domain a Target serves, before anything stops or starts", async () => {
  const f = await installed(SERVER);
  await writeFile(
    join(f.root, "config.yaml"),
    "proxy:\n  caddy: /nonexistent/caddy\ndashboard:\n  domain: app.example.test\n",
  );
  // A Target's block in Rig's route file serves the hostname.
  const token = "a".repeat(64);
  const routes = proxyPaths(f.root).routes;
  await mkdir(join(routes, ".."), { recursive: true });
  await writeFile(
    routes,
    `# rig begin ${token}\napp.example.test {\n  reverse_proxy 127.0.0.1:3001\n}\n# rig end ${token}\n`,
  );
  const installation = createProxyInstallation({
    root: f.root,
    userHome: f.root,
    uid: process.getuid!(),
    userName: "test",
    mode: "process",
    run: runCommand,
  });
  await expect(installation.preflight()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    message: expect.stringContaining("dashboard.domain in Host config"),
  });
});

test("a dashboard edit waits for rigd install: doctor says so, and it is never a proxy setting rig proxy reload would apply", async () => {
  const f = await installed(SERVER);
  const proxy = parseHostConfig({
    proxy: { caddy: "/usr/local/bin/caddy" },
  }).proxy!;
  // rigd started serving rig.example.com on 4280, and Caddy accepted that; Host config now asks for 4281.
  const started = { domain: "rig.example.com", port: 4280, https: 443 };
  const accepted = withDashboardRoute(proxy, started);
  expect(
    await pendingSettings(f.root, withDashboardRoute(proxy, started), accepted),
  ).toBeUndefined();
  expect(
    await pendingSettings(
      f.root,
      withDashboardRoute(proxy, {
        domain: "rig.example.com",
        port: 4281,
        https: 443,
      }),
      accepted,
    ),
  ).toMatchObject({ fields: ["routes"] });
  // So rigd compares proxy settings with the route it publishes, and the dashboard check reports the edit.
  expect(
    dashboardCheck(
      "https://rig.example.com via http://127.0.0.1:4281",
      "https://rig.example.com via http://127.0.0.1:4280",
    ),
  ).toEqual({
    name: "dashboard",
    ok: false,
    message:
      "Host config asks for the dashboard at https://rig.example.com via http://127.0.0.1:4281, but rigd serves it at https://rig.example.com via http://127.0.0.1:4280.",
    reason: "dashboard-pending",
    hint: "Run rigd install: rigd reads the dashboard's settings as it starts, and rig proxy reload leaves its route as rigd started it.",
  });
  expect(dashboardCheck(undefined, "http://127.0.0.1:4280")).toMatchObject({
    ok: false,
    message:
      "Host config asks for the dashboard off, but rigd serves it at http://127.0.0.1:4280.",
  });
  expect(
    dashboardCheck("http://127.0.0.1:4280", "http://127.0.0.1:4280"),
  ).toMatchObject({
    ok: true,
  });
});

test("a published dashboard on a Caddy whose HTTPS port is not 443 is addressed with that port, and admits it", () => {
  const host = (https?: number) =>
    parseHostConfig({
      proxy: {
        caddy: "/usr/local/bin/caddy",
        ...(https ? { ports: { http: 8080, https } } : {}),
      },
      dashboard: { domain: "rig.example.com" },
    });
  expect(dashboardPublication(host())).toMatchObject({
    domain: "rig.example.com",
    authority: "rig.example.com",
  });
  const published = dashboardPublication(host(8443))!;
  expect(published).toMatchObject({
    domain: "rig.example.com",
    authority: "rig.example.com:8443",
  });
  expect(describeDashboard(4280, published)).toBe(
    "https://rig.example.com:8443 via http://127.0.0.1:4280",
  );
  // The authority is what the dashboard is told it is published as, so the browser's Host and Origin are its own.
  const policy = accessPolicy({
    publicHost: published.authority,
    dashboardHost: published.authority,
    port: 4280,
  });
  expect(policy.hosts.has("rig.example.com:8443")).toBe(true);
  expect(policy.origins.has("https://rig.example.com:8443")).toBe(true);
  expect(policy.relaysAt).toBeUndefined();
});

test("while rigd serves a published dashboard, settings that move Caddy's HTTPS port are refused until rigd install moves both", () => {
  const settings = (https: number) =>
    parseHostConfig({
      proxy: { caddy: "/usr/local/bin/caddy", ports: { http: 8080, https } },
    }).proxy!;
  const route = { domain: "rig.example.com", port: 4280, https: 8443 };
  expect(publishedProxySettings(settings(8443), route).routes).toEqual({
    "rig.example.com": 4280,
  });
  expect(() => publishedProxySettings(settings(8444), route)).toThrow(
    expect.objectContaining({
      code: "PROXY_CONFIG",
      message:
        "proxy.ports.https is now 8444, but the dashboard rigd serves at rig.example.com was started for 8443, so it would refuse the new address.",
      hint: expect.stringContaining("Run rigd install"),
    }),
  );
  // Without a published dashboard, the port moves on reload as before.
  expect(publishedProxySettings(settings(8444), undefined).ports.https).toBe(
    8444,
  );
});
