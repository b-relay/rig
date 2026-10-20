import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonAdmin } from "../src/daemon/admin";
import { readDaemonAddress, readDaemonToken } from "../src/daemon/files";
import { DaemonClient } from "../src/daemon/client";
import { processExists } from "../src/daemon/process-identity";

// The real daemon host and administration, with the real dashboard supervisor published through the scripted Caddy
// (tests/support/dashboard-daemon.ts): a stop whose withholding Caddy does not confirm leaves rigd serving and reachable.

const script = join(import.meta.dir, "support", "dashboard-daemon.ts");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => {});
});

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
async function until(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting");
}
async function rigRoot() {
  const root = await mkdtemp(join(tmpdir(), "rig-dashboard-stop-"));
  const port = freePort();
  await writeFile(join(root, "dashboard-port"), String(port));
  const loads = async () =>
    (await readFile(join(root, "caddy-loads"), "utf8").catch(() => ""))
      .trim()
      .split("\n");
  const dashboardPid = async () =>
    (
      JSON.parse(
        await readFile(join(root, "dashboard", "process.json"), "utf8"),
      ) as { pid: number }
    ).pid;
  return {
    root,
    live: `127.0.0.1:${port}`,
    loads,
    dashboardPid,
    /** Waits until Caddy routes the domain to rigd's dashboard. */
    served: async () => {
      await until(async () => (await loads()).at(-1) === `127.0.0.1:${port}`);
      // Time for the publication that loaded it to confirm what Caddy serves.
      await Bun.sleep(300);
    },
    unreachable: () => writeFile(join(root, "caddy-unreachable"), ""),
    reachable: () => rm(join(root, "caddy-unreachable"), { force: true }),
    hold: () => writeFile(join(root, "caddy-hold"), ""),
    answer: () => rm(join(root, "caddy-hold"), { force: true }),
    serving: `https://rig.example.test via http://127.0.0.1:${port}`,
  };
}
const refused = expect.objectContaining({
  code: "DAEMON_STOP",
  message: expect.stringContaining(
    "The running rigd could not stop safely, so it keeps serving: rigd was asked to stop, but Rig's Caddy has not confirmed that it withholds rig.example.test",
  ),
});

test("rigd install, rigd uninstall and a signal leave rigd serving, its dashboard routed, while Caddy cannot confirm the withholding; once it can, both stop", async () => {
  const f = await rigRoot();
  const admin = (...extra: string[]) =>
    new DaemonAdmin({
      root: f.root,
      command: [process.execPath, script, ...extra],
      mode: "process",
      userHome: f.root,
    });
  cleanups.push(async () => {
    await f.reachable();
    await admin().uninstall();
    await rm(f.root, { recursive: true, force: true });
  });
  expect(await admin().install()).toMatchObject({ reachable: true });
  await f.served();
  const rigd = (await readDaemonAddress(f.root))!.pid;
  const dashboard = await f.dashboardPid();
  await f.unreachable();
  // A replacement (an upgrade runs rigd install) and an uninstall are refused, saying why; rigd is not signalled.
  await expect(admin("again").install()).rejects.toEqual(refused);
  await expect(admin().uninstall()).rejects.toEqual(refused);
  // So is a stop by signal: rigd keeps serving.
  process.kill(rigd, "SIGTERM");
  await Bun.sleep(2500);
  const status = await admin().status();
  expect(status).toMatchObject({ running: true, reachable: true });
  expect(status.warnings).toContainEqual(
    expect.stringMatching(
      /^Dashboard: rigd was asked to stop, but Rig's Caddy has not confirmed/,
    ),
  );
  expect((await readDaemonAddress(f.root))!.pid).toBe(rigd);
  expect(processExists(dashboard)).toBe(true);
  expect(await fetch(`http://${f.live}/`).then((r) => r.text())).toBe(
    String(dashboard),
  );
  // Once Caddy answers, the uninstall withholds the domain, then stops the dashboard and rigd.
  await f.reachable();
  expect(await admin().uninstall()).toMatchObject({ outcome: "uninstalled" });
  expect((await f.loads()).at(-1)).toBe("withheld");
  expect(processExists(dashboard)).toBe(false);
  expect(processExists(rigd)).toBe(false);
}, 90_000);

/** Stands in for launchd: bootstrap starts the job's program, bootout stops it; nothing touches the real launchd. */
function fakeLaunchd(root: string) {
  const calls: string[][] = [];
  let child: ChildProcess | undefined;
  return {
    calls,
    async launchctl(args: readonly string[]) {
      calls.push([...args]);
      if (args[0] === "bootstrap") {
        child = spawn(process.execPath, [script], {
          env: { ...process.env, RIG_ROOT: root, RIG_DAEMON_CHILD: "1" },
          detached: true,
          stdio: "ignore",
        });
        await new Promise((resolve) => child!.once("spawn", resolve));
        child.unref();
      }
      if (args[0] === "bootout" && child) {
        process.kill(child.pid!, "SIGTERM");
        const pid = child.pid!;
        child = undefined;
        await until(() => !processExists(pid));
      }
      return { code: 0, stderr: "" };
    },
  };
}

test("a launchd rigd is not booted out while Caddy cannot confirm the dashboard's withholding", async () => {
  const f = await rigRoot();
  const launchd = fakeLaunchd(f.root);
  const admin = new DaemonAdmin({
    root: f.root,
    command: [process.execPath, script],
    mode: "launchd",
    userHome: f.root,
    uid: 501,
    launchctl: launchd.launchctl,
  });
  cleanups.push(async () => {
    await f.reachable();
    await admin.uninstall();
    await rm(f.root, { recursive: true, force: true });
  });
  expect(await admin.install()).toMatchObject({ reachable: true });
  await f.served();
  await f.unreachable();
  const installed = launchd.calls.length;
  await expect(admin.uninstall()).rejects.toEqual(refused);
  expect(launchd.calls.slice(installed)).toEqual([]);
  expect(await admin.status()).toMatchObject({ reachable: true });
  await f.reachable();
  expect(await admin.uninstall()).toMatchObject({ outcome: "uninstalled" });
  expect(launchd.calls.at(-1)?.[0]).toBe("bootout");
  expect((await f.loads()).at(-1)).toBe("withheld");
}, 90_000);

test("a stop whose withholding waits on Caddy is refused within its bound, through rigd install, and rigd keeps serving", async () => {
  const f = await rigRoot();
  const admin = (...extra: string[]) =>
    new DaemonAdmin({
      root: f.root,
      command: [process.execPath, script, ...extra],
      mode: "process",
      userHome: f.root,
    });
  cleanups.push(async () => {
    await f.answer();
    await f.reachable();
    await admin().uninstall();
    await rm(f.root, { recursive: true, force: true });
  });
  expect(await admin().install()).toMatchObject({ reachable: true });
  await f.served();
  const dashboard = await f.dashboardPid();
  // Caddy holds every publication: the withholding waits in its queue.
  await f.hold();
  const began = Date.now();
  await expect(admin("again").install()).rejects.toEqual(
    expect.objectContaining({
      code: "DAEMON_STOP",
      message: expect.stringContaining("it did not confirm within"),
    }),
  );
  expect(Date.now() - began).toBeLessThan(10_000);
  await f.answer();
  expect(await admin().status()).toMatchObject({ reachable: true });
  expect(processExists(dashboard)).toBe(true);
  await until(async () => (await f.loads()).at(-1) === f.live);
  expect(await admin().uninstall()).toMatchObject({ outcome: "uninstalled" });
  expect((await f.loads()).at(-1)).toBe("withheld");
}, 90_000);

test("a rigd readied to stop but never stopped says so, and rigd install of the same build starts it again with its dashboard", async () => {
  const f = await rigRoot();
  const admin = () =>
    new DaemonAdmin({
      root: f.root,
      command: [process.execPath, script],
      mode: "process",
      userHome: f.root,
      dashboard: async () => f.serving,
    });
  cleanups.push(async () => {
    await admin().uninstall();
    await rm(f.root, { recursive: true, force: true });
  });
  expect(await admin().install()).toMatchObject({ dashboard: f.serving });
  await f.served();
  const dashboard = await f.dashboardPid();
  // Two administrations ready it to stop; neither goes on to stop it.
  const address = (await readDaemonAddress(f.root))!;
  const client = new DaemonClient({
    port: address.port,
    token: await readDaemonToken(f.root),
  });
  expect(
    await Promise.all([
      client.command({ action: "prepare-stop" }),
      client.command({ action: "prepare-stop" }),
    ]),
  ).toEqual([{ ready: true }, { ready: true }]);
  expect(processExists(dashboard)).toBe(false);
  expect((await f.loads()).at(-1)).toBe("withheld");
  const status = await admin().status();
  expect(status.dashboard).toBeUndefined();
  expect(status.warnings).toContainEqual(
    "Dashboard: The dashboard was stopped so that rigd could stop. rigd install starts rigd again, and the dashboard with it.",
  );
  // The same build's install sees a rigd serving no dashboard, and starts it again.
  expect(await admin().install()).toMatchObject({
    outcome: "installed",
    replaced: { pid: address.pid },
    dashboard: f.serving,
  });
  await f.served();
}, 90_000);
