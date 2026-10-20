import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dashboardDirectory,
  openDashboard,
  takeOverDashboard,
  type Dashboard,
  type DashboardDependencies,
} from "../src/daemon/dashboard";
import type { PublishedDashboard } from "../src/domain/managed-proxy";
import { waitForLogPoll } from "../src/adapters/log-follow-scheduler";
import { DEFAULT_LOG_RETENTION } from "../src/domain/log-retention";
import { runCommand } from "../src/providers/command-runner";
import { createListenerInspection } from "../src/providers/listener-inspection";
import {
  processExists,
  processStartTime,
} from "../src/daemon/process-identity";
import {
  TOKEN,
  hostAnswer,
  managedCaddyWorld,
} from "./support/managed-caddy-double";

// Every assertion about routing reads what the scripted Caddy has loaded, never Rig's own files.

const DOMAIN = "rig.example.test";
const roots: string[] = [];
const processes: { kill(): void }[] = [];
afterEach(async () => {
  for (const child of processes.splice(0)) child.kill();
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
/** A dashboard that answers with its own pid. */
const SERVER = `
Bun.serve({
  port: Number(process.env.PORT),
  hostname: process.env.HOSTNAME,
  fetch: () => new Response(String(process.pid)),
});
`;
/** Another program on `port`, answering "foreign". */
function foreign(port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: () => new Response("foreign"),
  });
}
async function until(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting");
}
async function recordedPid(root: string): Promise<number | undefined> {
  return readFile(join(root, "dashboard", "process.json"), "utf8").then(
    (text) => (JSON.parse(text) as { pid: number }).pid,
    () => undefined,
  );
}
async function whoAnswers(upstream: string): Promise<string> {
  return fetch(`http://${upstream}/`).then(
    (response) => response.text(),
    () => "nothing",
  );
}

const app = {
  key: "app",
  sites: [
    {
      hostname: "app.example.test",
      routes: [{ prefix: "/", upstream: "127.0.0.1:3001" }],
    },
  ],
};

/** Rig's Caddy (scripted) publishing the dashboard rigd runs at DOMAIN. Every configuration Caddy loads is checked as it
 * loads: a dashboard domain may reach a port only while rigd's own recorded dashboard answers there. */
async function served(
  server = SERVER,
  options: Partial<DashboardDependencies> = {},
) {
  let dashboard: Dashboard | undefined;
  const w = await managedCaddyWorld({}, TOKEN, {
    current: () => dashboard?.route(),
    confirmed: async () => dashboard?.confirmedRoute(),
  });
  roots.push(w.root);
  const directory = dashboardDirectory(w.root);
  await mkdir(join(directory, "web"), { recursive: true });
  await writeFile(join(directory, "web", "server.js"), server);
  const port = freePort();
  const notes: string[] = [];
  const violations: string[] = [];
  const check = async (config: unknown) => {
    const dial = hostAnswer(config, DOMAIN);
    if (dial === undefined || dial === "withheld") return;
    const answer = await whoAnswers(dial);
    if (answer !== String(await recordedPid(w.root)))
      violations.push(`${DOMAIN} -> ${dial}, answered by ${answer}`);
  };
  w.control.onLoad = check;
  dashboard = (await openDashboard({
    root: w.root,
    port,
    directory,
    executable: process.execPath,
    published: { domain: DOMAIN, authority: DOMAIN, trustedClients: [] },
    retention: async () => DEFAULT_LOG_RETENTION,
    notices: {
      note: (_, message) => notes.push(message),
      clear: () => {},
    },
    listeners: createListenerInspection(runCommand),
    publish: async () => void (await w.caddy.refreshDashboard()),
    // Back-offs a tenth as long.
    wait: (ms, signal) => waitForLogPoll(ms / 10, signal),
    now: Date.now,
    ...options,
  }))!;
  // What rigd install, or rigd's start, publishes before the dashboard runs.
  await w.caddy.republish();
  const live = `127.0.0.1:${port}`;
  const log = () =>
    readFile(join(w.root, "logs", "dashboard", "dashboard.log"), "utf8").catch(
      () => "",
    );
  /** Waits until Caddy routes the domain to the dashboard, and the publication that did so has finished. */
  const routed = async () => {
    await until(() => w.servedHost(DOMAIN) === live);
    await w.caddy.refreshDashboard();
  };
  return { w, dashboard, port, live, notes, violations, check, log, routed };
}

test("the dashboard's domain reaches only rigd's own dashboard: not before it is found on its port, not while another program holds the port, and not once it has exited", async () => {
  const f = await served();
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  // Another program holds the port as rigd starts: the dashboard cannot bind, and its domain stays withheld.
  const first = foreign(f.port);
  f.dashboard.start();
  const held = `another program holds 127.0.0.1:${f.port}`;
  await until(() => f.notes.some((note) => note.includes(held)));
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  expect(f.dashboard.problem()).toContain(held);
  await until(async () => (await f.log()).includes(held));
  // Once it is free, the dashboard binds it, is found there, and only then is routed.
  first.stop(true);
  await f.routed();
  const pid = (await recordedPid(f.w.root))!;
  expect(await whoAnswers(f.live)).toBe(String(pid));
  expect(f.dashboard.problem()).toBeUndefined();
  // It exits: its domain is withheld before it is started again, so a program that takes the port in the back-off
  // receives nothing.
  process.kill(pid, "SIGKILL");
  await until(() => f.w.servedHost(DOMAIN) === "withheld");
  const second = foreign(f.port);
  const before = f.notes.filter((note) => note.includes(held)).length;
  await until(
    () => f.notes.filter((note) => note.includes(held)).length > before,
  );
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  second.stop(true);
  await f.routed();
  expect(await whoAnswers(f.live)).not.toBe(String(pid));
  await f.dashboard.stop();
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  expect(f.violations).toEqual([]);
}, 30_000);

test("a dashboard that runs but is never found on 127.0.0.1:<port> is never routed, and says so", async () => {
  // It listens on ::1 only, where Caddy never connects; another program may take 127.0.0.1 at that port.
  const f = await served(
    `
Bun.serve({ port: Number(process.env.PORT), hostname: "::1", fetch: () => new Response(String(process.pid)) });
`,
    { unverifiedReportMs: 0 },
  );
  const dashboard = f.dashboard;
  dashboard.start();
  const unfound = `does not listen on 127.0.0.1:${f.port}, so Rig's Caddy does not route its domain to it`;
  await until(() => f.notes.some((note) => note.includes(unfound)));
  const other = foreign(f.port);
  await Bun.sleep(300);
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  expect(dashboard.problem()).toContain(unfound);
  await until(async () => (await f.log()).includes(unfound));
  await dashboard.stop();
  other.stop(true);
  expect(f.violations).toEqual([]);
}, 30_000);

test("a stop withholds the domain, confirmed by Caddy, before it stops the dashboard; one Caddy does not confirm fails and leaves the dashboard running and routed", async () => {
  const f = await served(SERVER, { stopConfirmMs: 1000 });
  f.dashboard.start();
  await f.routed();
  const pid = (await recordedPid(f.w.root))!;
  let aliveWhenWithheld: boolean | undefined;
  f.w.control.onLoad = async (config) => {
    await f.check(config);
    if (hostAnswer(config, DOMAIN) === "withheld")
      aliveWhenWithheld ??= processExists(pid);
  };
  // Caddy runs but its admin socket does not answer.
  f.w.control.reachable = false;
  const refusal = `rigd was asked to stop, but Rig's Caddy has not confirmed that it withholds ${DOMAIN} from ${f.live}`;
  await expect(f.dashboard.stop()).rejects.toMatchObject({
    code: "DASHBOARD_WITHHOLD",
    message: expect.stringContaining(refusal),
  });
  expect(processExists(pid)).toBe(true);
  expect(f.w.servedHost(DOMAIN)).toBe(f.live);
  expect(await whoAnswers(f.live)).toBe(String(pid));
  expect(f.dashboard.route()).toEqual({ domain: DOMAIN, port: f.port });
  expect(f.dashboard.problem()).toContain(refusal);
  expect(f.notes.some((note) => note.includes(refusal))).toBe(true);
  expect(await f.log()).toContain(refusal);
  // Once Caddy answers, the next stop serves the withholding, then stops the dashboard.
  f.w.control.reachable = true;
  await f.dashboard.stop();
  expect(aliveWhenWithheld).toBe(true);
  expect(processExists(pid)).toBe(false);
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  expect(f.violations).toEqual([]);
}, 30_000);

test("a stop while the dashboard's route is being published waits for it, and the route Caddy ends up with is withheld", async () => {
  const f = await served();
  // Caddy takes its time over every load.
  let loads = 0;
  f.w.control.onLoad = async (config) => {
    loads++;
    await Bun.sleep(200);
    await f.check(config);
  };
  f.dashboard.start();
  await until(async () => (await recordedPid(f.w.root)) !== undefined);
  const pid = (await recordedPid(f.w.root))!;
  // Stopped as soon as the enabling publication has begun.
  await until(() => loads >= 1);
  await f.dashboard.stop();
  expect(processExists(pid)).toBe(false);
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  expect(f.violations).toEqual([]);
}, 30_000);

test("a rigd whose dashboard was served exits on its own once stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rig-dashboard-exit-"));
  roots.push(directory);
  const script = join(directory, "rigd.ts");
  const source = (path: string) =>
    JSON.stringify(join(import.meta.dir, "..", path));
  await writeFile(
    script,
    `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dashboardDirectory, openDashboard } from ${source("src/daemon/dashboard.ts")};
import { createListenerInspection } from ${source("src/providers/listener-inspection.ts")};
import { runCommand } from ${source("src/providers/command-runner.ts")};
import { waitForLogPoll } from ${source("src/adapters/log-follow-scheduler.ts")};
import { DEFAULT_LOG_RETENTION } from ${source("src/domain/log-retention.ts")};
import { TOKEN, managedCaddyWorld } from ${source("tests/support/managed-caddy-double.ts")};
let dashboard;
const w = await managedCaddyWorld({}, TOKEN, {
  current: () => dashboard?.route(),
  confirmed: async () => dashboard?.confirmedRoute(),
});
const directory = dashboardDirectory(w.root);
await mkdir(join(directory, "web"), { recursive: true });
await writeFile(join(directory, "web", "server.js"), ${JSON.stringify(SERVER)});
dashboard = await openDashboard({
  root: w.root, port: ${freePort()}, directory, executable: process.execPath,
  published: { domain: "${DOMAIN}", authority: "${DOMAIN}", trustedClients: [] },
  retention: async () => DEFAULT_LOG_RETENTION,
  notices: { note: () => {}, clear: () => {} },
  listeners: createListenerInspection(runCommand),
  publish: async () => void (await w.caddy.refreshDashboard()),
  wait: waitForLogPoll, now: Date.now,
});
await w.caddy.republish();
dashboard.start();
while (!w.servedHost("${DOMAIN}")?.startsWith("127.0.0.1")) await Bun.sleep(25);
await dashboard.stop();
console.log(w.servedHost("${DOMAIN}"));
await (await import("node:fs/promises")).rm(w.root, { recursive: true, force: true });
`,
  );
  const rigd = Bun.spawn([process.execPath, script], {
    stdout: "pipe",
    stderr: "inherit",
  });
  processes.push(rigd);
  const outcome = await Promise.race([
    rigd.exited,
    Bun.sleep(20_000).then(() => "still running"),
  ]);
  expect(outcome).toBe(0);
  expect((await new Response(rigd.stdout).text()).trim()).toBe("withheld");
}, 30_000);

test("a route publication queued while the dashboard was routed publishes nothing to its port once it has exited", async () => {
  const f = await served();
  // A Target's publication holds Caddy's queue: its load waits until released.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  f.w.control.onLoad = async (config) => {
    await f.check(config);
    if (holding) await held;
  };
  const target = f.w.caddy.router.apply(app);
  await until(() => f.w.servedRoutes().includes("app.example.test"));
  // The dashboard is found on its port meanwhile, so its route is asked for, and its publication waits in the queue.
  f.dashboard.start();
  await until(() => f.dashboard.route()?.port === f.port);
  const pid = (await recordedPid(f.w.root))!;
  // It dies, and another program takes the port, before the queue moves.
  process.kill(pid, "SIGKILL");
  await until(() => !processExists(pid));
  const other = foreign(f.port);
  holding = false;
  release();
  await target;
  await until(() => f.w.servedHost(DOMAIN) === "withheld");
  await Bun.sleep(300);
  expect(f.w.servedHost(DOMAIN)).not.toBe(f.live);
  expect(f.violations).toEqual([]);
  other.stop(true);
  await f.dashboard.stop();
  expect(f.violations).toEqual([]);
}, 30_000);

test("a route to the dashboard whose activation waits on Caddy is not loaded once the dashboard has exited", async () => {
  const f = await served();
  // Caddy's admin API holds its answer while it is asked to activate a generation routing the domain to the dashboard.
  let release = () => {};
  const answer = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  f.w.control.beforeConfig = async () => {
    const current = await readFile(
      join(f.w.root, "caddy", "current", "generation.json"),
      "utf8",
    ).catch(() => "{}");
    if (
      holding ||
      (JSON.parse(current) as { dashboard?: PublishedDashboard }).dashboard
        ?.port != null
    ) {
      holding = true;
      await answer;
    }
  };
  f.dashboard.start();
  await until(() => holding);
  const pid = (await recordedPid(f.w.root))!;
  // It dies, and another program takes the port, while the activation waits.
  process.kill(pid, "SIGKILL");
  await until(() => f.dashboard.route()?.port === null);
  const other = foreign(f.port);
  f.w.control.beforeConfig = undefined;
  release();
  await until(() => f.w.servedHost(DOMAIN) === "withheld");
  await Bun.sleep(300);
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  expect(f.violations).toEqual([]);
  other.stop(true);
  await f.dashboard.stop();
  expect(f.violations).toEqual([]);
}, 30_000);

test("a stop whose withholding waits behind Caddy gives up at its bound, and the dashboard stays routed once Caddy answers", async () => {
  const f = await served(SERVER, { stopConfirmMs: 300 });
  f.dashboard.start();
  await f.routed();
  const pid = (await recordedPid(f.w.root))!;
  // Every publication waits on Caddy's admin API.
  let release = () => {};
  const answer = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.w.control.beforeConfig = () => answer;
  const began = Date.now();
  await expect(f.dashboard.stop()).rejects.toMatchObject({
    code: "DASHBOARD_WITHHOLD",
    message: expect.stringContaining("it did not confirm within 1 s"),
  });
  expect(Date.now() - began).toBeLessThan(2000);
  expect(processExists(pid)).toBe(true);
  // The publication that waited is served late; Caddy ends with the route rigd asks for again.
  f.w.control.beforeConfig = undefined;
  release();
  await Bun.sleep(500);
  expect(f.w.servedHost(DOMAIN)).toBe(f.live);
  expect(f.dashboard.route()).toEqual({ domain: DOMAIN, port: f.port });
  await f.dashboard.stop();
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  expect(f.violations).toEqual([]);
}, 30_000);

test("a stop while the supervisor waits on Caddy to withhold an exited dashboard's domain returns within its bound", async () => {
  const f = await served(SERVER, { stopConfirmMs: 200 });
  f.dashboard.start();
  await f.routed();
  const pid = (await recordedPid(f.w.root))!;
  // Caddy holds every publication; the dashboard dies, and its supervisor waits on the withholding.
  let release = () => {};
  const answer = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.w.control.beforeConfig = () => answer;
  process.kill(pid, "SIGKILL");
  await until(() => f.dashboard.route()?.port === null);
  await Bun.sleep(300);
  const began = Date.now();
  await f.dashboard.stop();
  expect(Date.now() - began).toBeLessThan(1000);
  // The withholding still under way is served late; nothing routes the domain to whatever takes the port.
  const other = foreign(f.port);
  f.w.control.beforeConfig = undefined;
  release();
  await until(() => f.w.servedHost(DOMAIN) === "withheld");
  await Bun.sleep(300);
  expect(f.w.servedHost(DOMAIN)).toBe("withheld");
  expect(f.violations).toEqual([]);
  other.stop(true);
}, 30_000);

test("a withholding Caddy loads only after the stop gave up is followed by the route rigd asks for: live while the dashboard runs, withheld once it has exited", async () => {
  for (const exits of [false, true]) {
    const f = await served(SERVER, { stopConfirmMs: 300 });
    f.dashboard.start();
    await f.routed();
    const pid = (await recordedPid(f.w.root))!;
    // Caddy loads the withholding, then holds before it confirms it.
    let release = () => {};
    const confirmation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loads: (string | undefined)[] = [];
    f.w.control.onLoad = async (config) => {
      loads.push(hostAnswer(config, DOMAIN));
      if (loads.length === 1) await confirmation;
      else await f.check(config);
    };
    await expect(f.dashboard.stop()).rejects.toMatchObject({
      code: "DASHBOARD_WITHHOLD",
    });
    expect(loads).toEqual(["withheld"]);
    let other: { stop(force: boolean): void } | undefined;
    if (exits) {
      // Before Caddy confirms it, the dashboard dies and another program takes its port.
      process.kill(pid, "SIGKILL");
      await until(() => f.dashboard.route()?.port === null);
      other = foreign(f.port);
    }
    release();
    await until(() => loads.length > 1 || exits);
    await Bun.sleep(500);
    expect([exits, loads]).toEqual([
      exits,
      exits ? ["withheld"] : ["withheld", f.live],
    ]);
    expect(f.w.servedHost(DOMAIN)).toBe(exits ? "withheld" : f.live);
    expect(f.violations).toEqual([]);
    other?.stop(true);
    await f.dashboard.stop();
  }
}, 60_000);

test("a generation that routes the dashboard to a port rigd no longer confirms is never loaded, even when a crash left it current", async () => {
  const port = freePort();
  let dashboard: PublishedDashboard | undefined = {
    domain: DOMAIN,
    port: null,
  };
  const w = await managedCaddyWorld({}, TOKEN, () => dashboard);
  roots.push(w.root);
  await w.caddy.router.apply(app);
  const loaded: (string | undefined)[] = [];
  w.control.onLoad = async (config) => {
    loaded.push(hostAnswer(config, DOMAIN));
  };
  // rigd found its dashboard on the port and built a generation routing to it, then died before Caddy loaded it.
  dashboard = { domain: DOMAIN, port };
  w.control.ignoreReload = true;
  await expect(w.caddy.refreshDashboard()).rejects.toMatchObject({
    code: "PROXY_ACTIVATION",
  });
  const generations = await w.generations();
  const switched = join(w.root, "caddy", "current.crash");
  await symlink(join("generations", generations.at(-1)!), switched);
  await rename(switched, join(w.root, "caddy", "current"));
  w.control.ignoreReload = false;
  expect(w.servedHost(DOMAIN)).toBe("withheld");
  // The next rigd asks for the domain withheld, another program holds the port, and Host config is refused.
  dashboard = { domain: DOMAIN, port: null };
  const other = foreign(port);
  w.setSettings({ routes: { "app.example.test": 3005 } });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
  });
  await w.caddy.refreshDashboard();
  await w.caddy.router.apply({
    ...app,
    sites: [
      {
        hostname: "app.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:3002" }],
      },
    ],
  });
  other.stop(true);
  expect(loaded).not.toContain(`127.0.0.1:${port}`);
  expect(w.servedHost(DOMAIN)).toBe("withheld");
}, 30_000);

/** A Caddy serving the dashboard's route to `port`, whose CA-change restart stops it and then fails once (`after` is how
 * its job then stands: a process stopped, launchd backing off). `next` is what rigd confirms once `change` says so. */
async function failedRestartWorld(
  port: number,
  after: "stopped" | "unknown",
  change: (restarts: number, reachable: boolean) => boolean,
  next: PublishedDashboard,
) {
  let dashboard: PublishedDashboard = { domain: DOMAIN, port };
  const control = { restarts: 0, reachable: true };
  const confirm = () => {
    if (change(control.restarts, control.reachable)) dashboard = next;
    return dashboard;
  };
  const w = await managedCaddyWorld({ tls: { ca: "internal" } }, TOKEN, {
    current: () => dashboard,
    confirmed: async () => confirm(),
  });
  roots.push(w.root);
  await w.caddy.router.apply(app);
  expect(w.servedHost(DOMAIN)).toBe(`127.0.0.1:${port}`);
  // What Caddy loads, from here on, for the dashboard's domain; the double's state is mirrored for `change`.
  const loaded: (string | undefined)[] = [];
  w.control.onLoad = async (config) => {
    loaded.push(hostAnswer(config, DOMAIN));
  };
  w.control.beforeConfig = async () => {
    Object.assign(control, {
      restarts: w.control.restarts,
      reachable: w.control.reachable,
    });
    confirm();
  };
  w.control.failingRestarts = 1;
  w.control.afterFailedRestart = after;
  w.setSettings({ tls: { ca: "https://127.0.0.1:65534/acme" } });
  return { w, loaded };
}

test("a rollback that starts Caddy again never loads a dashboard route rigd stopped confirming while it asked what Caddy runs", async () => {
  for (const after of ["stopped", "unknown"] as const) {
    const port = freePort();
    // The dashboard ends just as the rollback finds Caddy not answering.
    const { w, loaded } = await failedRestartWorld(
      port,
      after,
      (restarts, reachable) => restarts === 1 && !reachable,
      { domain: DOMAIN, port: null },
    );
    await expect(w.caddy.republish()).rejects.toMatchObject({
      code: "PROXY_START",
      message: expect.stringContaining(
        "the previous configuration was restored",
      ),
    });
    expect(loaded).not.toContain(`127.0.0.1:${port}`);
    expect(w.servedHost(DOMAIN)).toBe("withheld");
    expect(w.control.state).toBe("running");
  }
});

test("a dashboard that ends while Rig records the restart it is about to make is never routed by that restart", async () => {
  const port = freePort();
  let dashboard: PublishedDashboard = { domain: DOMAIN, port };
  const w = await managedCaddyWorld(
    { tls: { ca: "internal" } },
    TOKEN,
    () => dashboard,
  );
  roots.push(w.root);
  await w.caddy.router.apply(app);
  expect(w.servedHost(DOMAIN)).toBe(`127.0.0.1:${port}`);
  const loaded: (string | undefined)[] = [];
  w.control.onLoad = async (config) => {
    loaded.push(hostAnswer(config, DOMAIN));
  };
  // Once activation has asked Caddy what it runs (and checked the route), the next read of the clock is the restart's
  // record being written: the dashboard ends then.
  let checked = false;
  w.control.beforeConfig = async () => {
    checked = true;
  };
  w.control.beforeNow = () => {
    if (checked) dashboard = { domain: DOMAIN, port: null };
  };
  w.setSettings({ tls: { ca: "https://127.0.0.1:65534/acme" } });
  await w.caddy.republish();
  expect(loaded).not.toContain(`127.0.0.1:${port}`);
  expect(w.servedHost(DOMAIN)).toBe("withheld");
  expect(
    await stat(join(w.root, "caddy", "restore.json")).catch(() => undefined),
  ).toBeUndefined();
});

test("a rollback whose dashboard route changed is published again as rigd confirms it, and Caddy is started on that", async () => {
  for (const after of ["stopped", "unknown"] as const)
    for (const next of ["exit", "port"] as const) {
      const port = freePort();
      const moved = freePort();
      // The dashboard exits, or is found on another port, before the rollback reconciles.
      const { w, loaded } = await failedRestartWorld(
        port,
        after,
        (restarts) => restarts === 1,
        { domain: DOMAIN, port: next === "exit" ? null : moved },
      );
      await expect(w.caddy.republish()).rejects.toMatchObject({
        code: "PROXY_START",
        message: expect.stringContaining(
          "the previous configuration was restored",
        ),
      });
      expect(w.control.restarts).toBe(2);
      expect(w.control.state).toBe("running");
      expect(loaded).not.toContain(`127.0.0.1:${port}`);
      expect(w.servedHost(DOMAIN)).toBe(
        next === "exit" ? "withheld" : `127.0.0.1:${moved}`,
      );
    }
});

/** A dashboard an earlier rigd left running on `port`, with its record, as a rigd that was killed leaves it. */
async function leftOver(root: string, port: number) {
  const directory = join(root, "left");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "server.js"), SERVER);
  const left = Bun.spawn([process.execPath, "server.js"], {
    cwd: directory,
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdout: "ignore",
  });
  processes.push(left);
  await until(
    async () => (await whoAnswers(`127.0.0.1:${port}`)) !== "nothing",
  );
  await mkdir(join(root, "dashboard"), { recursive: true });
  await writeFile(
    join(root, "dashboard", "process.json"),
    JSON.stringify({
      pid: left.pid,
      startedAt: await processStartTime(left.pid),
    }),
  );
  return left;
}
/** The takeover rigd's start runs, confirming with `caddy` as composition does. */
function takeOver(
  root: string,
  caddy: { refreshDashboard(): Promise<{ known: boolean }> },
  options: { stopped?: () => boolean; wait?: () => Promise<void> } = {},
) {
  const reports: string[] = [];
  const takeover = takeOverDashboard({
    root,
    withheld: async () => {
      if (!(await caddy.refreshDashboard()).known)
        throw new Error("its routes are an older rigd's");
    },
    notices: { note: (_, message) => reports.push(message) },
    retention: async () => DEFAULT_LOG_RETENTION,
    stopped: options.stopped ?? (() => false),
    wait: options.wait ?? (async () => {}),
  });
  return { done: takeover.done, reports, problem: takeover.problem };
}

test("a rigd started after one that died between switching Caddy's generation and loading it stops the dashboard left running only once Caddy has loaded the withholding", async () => {
  const port = freePort();
  let dashboard: PublishedDashboard | undefined = { domain: DOMAIN, port };
  const w = await managedCaddyWorld({}, TOKEN, () => dashboard);
  roots.push(w.root);
  const left = await leftOver(w.root, port);
  // The earlier rigd routed its domain to its dashboard.
  await w.caddy.republish();
  expect(w.servedHost(DOMAIN)).toBe(`127.0.0.1:${port}`);
  // Its successor built and switched to a generation withholding it, then died before Caddy loaded it.
  dashboard = { domain: DOMAIN, port: null };
  w.control.ignoreReload = true;
  await expect(w.caddy.refreshDashboard()).rejects.toMatchObject({
    code: "PROXY_ACTIVATION",
  });
  const switched = join(w.root, "caddy", "current.crash");
  await symlink(join("generations", "g002"), switched);
  await rename(switched, join(w.root, "caddy", "current"));
  w.control.ignoreReload = false;
  expect(w.servedHost(DOMAIN)).toBe(`127.0.0.1:${port}`);
  // The next rigd starts while Caddy's admin socket does not answer.
  w.control.reachable = false;
  let waits = 0;
  let answeredAtExit: string | undefined;
  void left.exited.then(() => {
    answeredAtExit = w.servedHost(DOMAIN);
  });
  const takeover = takeOver(w.root, w.caddy, {
    wait: async () => {
      waits++;
      expect(processExists(left.pid)).toBe(true);
      if (waits === 2) w.control.reachable = true;
    },
  });
  expect(await takeover.done).toBe(true);
  await left.exited;
  expect(answeredAtExit).toBe("withheld");
  expect(takeover.reports).toHaveLength(2);
  expect(takeover.reports[0]).toContain(
    `A dashboard an earlier rigd left running (pid ${left.pid}) keeps running until Rig's Caddy is confirmed to withhold its domain`,
  );
}, 30_000);

test("a dashboard turned off, moved to another domain, or moved to another port is never routed to its old port, even when the new Host config is refused", async () => {
  const old = freePort();
  const cases: {
    name: string;
    next: PublishedDashboard | undefined;
    verified?: number;
  }[] = [
    { name: "off", next: undefined },
    { name: "moved", next: { domain: "moved.example.test", port: null } },
    {
      name: "new port",
      next: { domain: DOMAIN, port: null },
      verified: freePort(),
    },
  ];
  for (const { name, next, verified } of cases) {
    let dashboard: PublishedDashboard | undefined = {
      domain: DOMAIN,
      port: old,
    };
    const w = await managedCaddyWorld({}, TOKEN, () => dashboard);
    roots.push(w.root);
    const left = await leftOver(w.root, old);
    await w.caddy.router.apply(app);
    expect(w.servedHost(DOMAIN)).toBe(`127.0.0.1:${old}`);
    // The next rigd serves the dashboard as Host config now says, which Rig refuses: a Target serves a hostname it routes.
    dashboard = next;
    w.setSettings({ routes: { "app.example.test": 3005 } });
    await expect(w.caddy.republish()).rejects.toMatchObject({
      code: "ROUTE_CONFLICT",
    });
    expect([name, w.servedHost(DOMAIN)]).toEqual([
      name,
      next?.domain === DOMAIN ? "withheld" : undefined,
    ]);
    if (next) expect(w.servedHost(next.domain)).toBe("withheld");
    // So the left-over dashboard is stopped at once, and the Target's route is still served.
    expect(await takeOver(w.root, w.caddy).done).toBe(true);
    await left.exited;
    expect(w.servedRoutes()).toContain("reverse_proxy 127.0.0.1:3001");
    if (verified === undefined) continue;
    // Found on its new port, the dashboard is routed there, and a Target's route change keeps it there.
    dashboard = { domain: DOMAIN, port: verified };
    await w.caddy.refreshDashboard();
    expect(w.servedHost(DOMAIN)).toBe(`127.0.0.1:${verified}`);
    await w.caddy.router.apply({
      ...app,
      sites: [
        {
          hostname: "app.example.test",
          routes: [{ prefix: "/", upstream: "127.0.0.1:3002" }],
        },
      ],
    });
    expect(w.servedHost(DOMAIN)).toBe(`127.0.0.1:${verified}`);
  }
}, 30_000);

test("a generation an older rigd published, which does not say which route is a dashboard's, is unknown: the left-over dashboard keeps running until Host config is published", async () => {
  const old = freePort();
  let dashboard: PublishedDashboard | undefined;
  const w = await managedCaddyWorld({}, TOKEN, () => dashboard);
  roots.push(w.root);
  // An older rigd folded its dashboard's route (old.example.test) into proxy.routes, and recorded nothing more.
  w.setSettings({ routes: { "old.example.test": old } });
  await w.caddy.router.apply(app);
  const metadata = join(
    w.root,
    "caddy",
    "generations",
    "g001",
    "generation.json",
  );
  const legacy = JSON.parse(await readFile(metadata, "utf8")) as Record<
    string,
    unknown
  >;
  delete legacy.dashboard;
  delete legacy.ownerRoutesOnly;
  await writeFile(metadata, JSON.stringify(legacy));
  const left = await leftOver(w.root, old);
  expect(w.servedHost("old.example.test")).toBe(`127.0.0.1:${old}`);
  // This rigd publishes its dashboard at another domain, and Host config is refused.
  dashboard = { domain: DOMAIN, port: null };
  w.setSettings({ routes: { "app.example.test": 3005 } });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
  });
  expect(w.servedHost(DOMAIN)).toBe("withheld");
  // Publications made with the older settings stay unknown.
  await w.caddy.router.apply({
    ...app,
    sites: [
      {
        hostname: "app.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:3002" }],
      },
    ],
  });
  expect(await w.caddy.refreshDashboard()).toEqual({ known: false });
  let tries = 0;
  const waiting = takeOver(w.root, w.caddy, {
    stopped: () => tries >= 2,
    wait: async () => void tries++,
  });
  expect(await waiting.done).toBe(false);
  expect(processExists(left.pid)).toBe(true);
  // Said with no dashboard of this rigd's involved: doctor's notice, rigd status's problem, and the dashboard's log.
  expect(waiting.reports[0]).toContain("its routes are an older rigd's");
  expect(waiting.problem()).toBe(waiting.reports.at(-1));
  expect(
    await readFile(join(w.root, "logs", "dashboard", "dashboard.log"), "utf8"),
  ).toContain(`[rigd] ${waiting.reports[0]}`);
  // Once Host config is published, Caddy's routes are known, and the left-over dashboard is stopped.
  w.setSettings({ routes: {} });
  expect(await w.caddy.republish()).toEqual({ published: true });
  expect(w.servedHost("old.example.test")).toBeUndefined();
  let answeredAtExit: string | undefined;
  void left.exited.then(() => {
    answeredAtExit = w.servedHost("old.example.test");
  });
  expect(await takeOver(w.root, w.caddy).done).toBe(true);
  await left.exited;
  expect(answeredAtExit).toBeUndefined();
}, 30_000);
