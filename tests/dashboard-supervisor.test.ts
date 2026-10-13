import { afterEach, expect, test } from "bun:test";
import {
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
  dashboardDirectory,
  openDashboard,
  type DashboardDependencies,
} from "../src/daemon/dashboard";
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
    wait: async (ms) => void waits.push(ms),
    now: Date.now,
  };
  return { root, directory, deps, notes, cleared, waits };
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
async function answer(url: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 100; attempt++) {
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
  await dashboard.start();
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
  await dashboard.start();
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
  const dashboard = (await openDashboard(f.deps))!;
  await dashboard.start();
  await left.exited;
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
  const dashboard = (await openDashboard(f.deps))!;
  await dashboard.start();
  expect(await answer(dashboard.url)).toBeDefined();
  expect(processExists(other.pid)).toBe(true);
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
