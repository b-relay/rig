import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonAdmin } from "../src/daemon/admin";
import { processExists } from "../src/daemon/host";

test("an empty daemon command fails before acquiring a startup log", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-invalid-"));
  try {
    const admin = new DaemonAdmin({
      root,
      command: [],
      mode: "process",
      userHome: root,
    });
    await expect(admin.install()).rejects.toMatchObject({
      code: "DAEMON_COMMAND",
    });
    await expect(
      readFile(join(root, "daemon", "startup.log")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon install starts a real service; status notices exit; uninstall preserves project state", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-"));
  const script = join(root, "child.ts");
  const hostModule = join(import.meta.dir, "../src/daemon/host.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(hostModule)}; await runDaemonHost({root:process.env.RIG_ROOT!,handle:async()=>({ready:true}),shutdown:async()=>{},port:0});`,
  );
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, script],
    mode: "process",
    userHome: root,
  });
  try {
    await admin.install();
    expect(await admin.status()).toMatchObject({
      installed: true,
      running: true,
      reachable: true,
    });
    await writeFile(join(root, "precious-data"), "preserve me");
    await admin.uninstall();
    expect(await admin.status()).toMatchObject({
      installed: false,
      running: false,
      reachable: false,
    });
    expect(await readFile(join(root, "precious-data"), "utf8")).toBe(
      "preserve me",
    );
  } finally {
    await admin.uninstall().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("a cleanly stopped daemon uninstalls without a running rigd: the installation and its credential are removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-stopped-"));
  const script = join(root, "child.ts");
  const hostModule = join(import.meta.dir, "../src/daemon/host.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(hostModule)}; await runDaemonHost({root:process.env.RIG_ROOT!,handle:async()=>({ready:true}),shutdown:async()=>{},port:0});`,
  );
  const admin = new DaemonAdmin({ root, command: [process.execPath, script], mode: "process", userHome: root });
  try {
    await admin.install();
    const address = JSON.parse(await readFile(join(root, "daemon", "address.json"), "utf8")) as { pid: number };
    process.kill(address.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (processExists(address.pid) && Date.now() < deadline) await Bun.sleep(50);
    expect(processExists(address.pid)).toBe(false);
    expect(await admin.status()).toMatchObject({ installed: true, running: false, reachable: false });
    expect(await admin.uninstall()).toMatchObject({ outcome: "uninstalled", installed: false, running: false });
    await expect(readFile(join(root, "daemon", "install.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "auth", "control-plane.token"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await admin.status()).toMatchObject({ installed: false, running: false, reachable: false });
  } finally {
    await admin.uninstall().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
test("a reachable daemon whose install record is missing is adopted by install and stopped by uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-unmarked-"));
  const script = join(root, "child.ts");
  const hostModule = join(import.meta.dir, "../src/daemon/host.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(hostModule)}; await runDaemonHost({root:process.env.RIG_ROOT!,handle:async()=>({ready:true}),shutdown:async()=>{},port:0});`,
  );
  const admin = new DaemonAdmin({ root, command: [process.execPath, script], mode: "process", userHome: root });
  try {
    await admin.install();
    await rm(join(root, "daemon", "install.json"));
    expect(await admin.status()).toMatchObject({ installed: false, running: true, reachable: true });
    expect(await admin.install()).toMatchObject({ outcome: "installed", installed: true, reachable: true });
    expect(JSON.parse(await readFile(join(root, "daemon", "install.json"), "utf8"))).toMatchObject({ mode: "process" });
    await rm(join(root, "daemon", "install.json"));
    const address = JSON.parse(await readFile(join(root, "daemon", "address.json"), "utf8")) as { pid: number };
    expect(await admin.uninstall()).toMatchObject({ outcome: "uninstalled", installed: false, running: false });
    expect(processExists(address.pid)).toBe(false);
    expect(await admin.status()).toMatchObject({ installed: false, running: false, reachable: false });
  } finally {
    await admin.uninstall().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
test("a process-mode install gives rigd the login basics plus its own variables, never the installer's secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-env-"));
  const script = join(root, "child.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/host.ts"))}; import {writeFile} from 'node:fs/promises'; await writeFile(process.env.RIG_ROOT+'/env.json', JSON.stringify(process.env)); await runDaemonHost({root:process.env.RIG_ROOT!,handle:async()=>({ready:true}),shutdown:async()=>{},port:0});`,
  );
  const admin = new DaemonAdmin({ root, command: [process.execPath, script], mode: "process", userHome: root });
  process.env.RIG_TEST_INSTALLER_SECRET = "hunter2";
  try {
    await admin.install();
    const env = JSON.parse(await readFile(join(root, "env.json"), "utf8")) as Record<string, string>;
    expect(env).not.toHaveProperty("RIG_TEST_INSTALLER_SECRET");
    expect(env).toMatchObject({ RIG_ROOT: root, RIG_DAEMON_CHILD: "1", PATH: process.env.PATH!, HOME: process.env.HOME! });
  } finally {
    delete process.env.RIG_TEST_INSTALLER_SECRET;
    await admin.uninstall().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("installation is reachable while initial Target reconciliation is still pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-slow-"));
  const script = join(root, "child.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/host.ts"))}; await runDaemonHost({root:process.env.RIG_ROOT!,handle:async()=>({ready:true}),start:async()=>{await new Promise(()=>{})},shutdown:async()=>{},port:0});`,
  );
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, script],
    mode: "process",
    userHome: root,
  });
  try {
    expect(await admin.install()).toMatchObject({
      running: true,
      reachable: true,
    });
    await admin.uninstall();
  } finally {
    try {
      const owner = JSON.parse(
        await readFile(join(root, "daemon", "owner.json"), "utf8"),
      );
      process.kill(owner.pid, "SIGKILL");
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("status treats a dead recorded pid as a stopped daemon without contacting its port", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-stale-"));
  const received: string[] = [];
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received.push(request.headers.get("authorization") ?? "none");
      return Response.json({ instanceId: "fixture", pid: 2147483647, running: true });
    },
  });
  try {
    await mkdir(join(root, "daemon"), { recursive: true });
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(
      join(root, "daemon", "address.json"),
      JSON.stringify({ port: foreign.port, pid: 2147483647, instanceId: "fixture" }),
    );
    await writeFile(join(root, "auth", "control-plane.token"), "secret");
    const admin = new DaemonAdmin({
      root,
      command: [process.execPath, "unused"],
      mode: "process",
      userHome: root,
    });
    expect(await admin.status()).toEqual({
      installed: false,
      running: false,
      reachable: false,
    });
    expect(received).toEqual([]);
  } finally {
    await foreign.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("reinstalling with no daemon running rotates the control-plane token", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-rotate-"));
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, await daemonScript(root)],
    mode: "process",
    userHome: root,
  });
  const tokenPath = join(root, "auth", "control-plane.token");
  try {
    await admin.install();
    const first = await readFile(tokenPath, "utf8");
    expect(await admin.install()).toMatchObject({ outcome: "unchanged" });
    expect(await readFile(tokenPath, "utf8")).toBe(first);
    // The daemon dies without cleaning up; its address record goes stale.
    const address = JSON.parse(
      await readFile(join(root, "daemon", "address.json"), "utf8"),
    ) as { pid: number };
    process.kill(address.pid, "SIGKILL");
    while (processExists(address.pid)) await Bun.sleep(20);
    expect(await admin.status()).toMatchObject({ running: false, reachable: false });
    await admin.install();
    expect(await readFile(tokenPath, "utf8")).not.toBe(first);
    expect(await admin.status()).toMatchObject({ reachable: true });
  } finally {
    await admin.uninstall().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("owner evidence recorded without process identity names the files to remove, and uninstall refuses to signal the pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-owner-"));
  try {
    await mkdir(join(root, "daemon"));
    const owner = join(root, "daemon", "owner.json");
    await writeFile(
      owner,
      JSON.stringify({ pid: process.pid, instanceId: crypto.randomUUID() }),
    );
    const admin = new DaemonAdmin({
      root,
      command: [],
      mode: "process",
      userHome: root,
    });
    expect(await admin.status()).toEqual({
      installed: false,
      running: true,
      reachable: false,
      warnings: [expect.stringContaining(owner)],
    });
    await expect(admin.install()).rejects.toMatchObject({
      code: "DAEMON_UNREACHABLE",
      hint: expect.stringContaining(owner),
    });
    await writeFile(
      join(root, "daemon", "install.json"),
      JSON.stringify({ mode: "process", command: [] }),
    );
    await expect(admin.uninstall()).rejects.toMatchObject({
      code: "DAEMON_UNCERTAIN",
      hint: expect.stringContaining(owner),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a recorded pid that now belongs to another process is a stopped daemon: nothing is contacted or signalled, and install and uninstall proceed", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-reused-"));
  const received: string[] = [];
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received.push(request.headers.get("authorization") ?? "none");
      return Response.json({ instanceId: "fixture", pid: process.pid, running: true });
    },
  });
  try {
    await mkdir(join(root, "daemon"));
    await mkdir(join(root, "auth"));
    await writeFile(join(root, "auth", "control-plane.token"), "secret");
    const reused = { pid: process.pid, instanceId: crypto.randomUUID(), startedAt: "Thu Jan  1 00:00:00 1970" };
    await writeFile(join(root, "daemon", "owner.json"), JSON.stringify(reused));
    await writeFile(
      join(root, "daemon", "address.json"),
      JSON.stringify({ ...reused, port: foreign.port }),
    );
    const admin = new DaemonAdmin({
      root,
      command: [],
      mode: "process",
      userHome: root,
    });
    expect(await admin.status()).toEqual({
      installed: false,
      running: false,
      reachable: false,
    });
    expect(received).toEqual([]);
    // Past the liveness check: the next failure is the empty command.
    await expect(admin.install()).rejects.toMatchObject({ code: "DAEMON_COMMAND" });
    await writeFile(
      join(root, "daemon", "install.json"),
      JSON.stringify({ mode: "process", command: [] }),
    );
    expect(await admin.uninstall()).toMatchObject({ outcome: "uninstalled" });
  } finally {
    await foreign.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
test("rigd startup reclaims a lease whose pid was reused, and refuses one recorded without identity by naming the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-lease-"));
  const script = join(root, "child.ts");
  await mkdir(join(root, "daemon"));
  await mkdir(join(root, "auth"));
  await writeFile(join(root, "auth", "control-plane.token"), "test-secret");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/host.ts"))}; await runDaemonHost({root:process.env.RIG_ROOT!,port:0,handle:async()=>({}),shutdown:async()=>{}});`,
  );
  const start = () =>
    Bun.spawn([process.execPath, script], {
      cwd: root,
      env: { ...process.env, RIG_ROOT: root },
      stdout: "ignore",
      stderr: "pipe",
    });
  const owner = join(root, "daemon", "owner.json");
  try {
    await writeFile(
      owner,
      JSON.stringify({ pid: process.pid, instanceId: crypto.randomUUID() }),
    );
    const refused = start();
    expect(await refused.exited).not.toBe(0);
    const stderr = await new Response(refused.stderr).text();
    expect(stderr).toContain("DAEMON_RUNNING");
    expect(stderr).toContain(owner);
    await writeFile(
      owner,
      JSON.stringify({ pid: process.pid, instanceId: crypto.randomUUID(), startedAt: "Thu Jan  1 00:00:00 1970" }),
    );
    const child = start();
    try {
      const deadline = Date.now() + 10000;
      let address: { pid: number } | undefined;
      while (!address && Date.now() < deadline) {
        address = await readFile(join(root, "daemon", "address.json"), "utf8")
          .then((text) => JSON.parse(text) as { pid: number })
          .catch(() => undefined);
        if (!address) await Bun.sleep(50);
      }
      expect(address).toMatchObject({ pid: child.pid });
      expect(JSON.parse(await readFile(owner, "utf8"))).toMatchObject({
        pid: child.pid,
        startedAt: expect.stringMatching(/\d{4}$/),
      });
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("corrupt ownership evidence refuses installation without replacing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-corrupt-"));
  try {
    await mkdir(join(root, "daemon"));
    await writeFile(join(root, "daemon", "owner.json"), "broken");
    const admin = new DaemonAdmin({
      root,
      command: [],
      mode: "process",
      userHome: root,
    });
    await expect(admin.install()).rejects.toMatchObject({
      code: "DAEMON_STATE",
    });
    expect(await readFile(join(root, "daemon", "owner.json"), "utf8")).toBe(
      "broken",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed daemon stop cancels uninstall quiescence and preserves installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-stop-"));
  const script = join(root, "child.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/host.ts"))}; import {writeFile} from 'node:fs/promises'; await runDaemonHost({root:process.env.RIG_ROOT!,port:0,shutdown:async()=>{},handle:async(command)=>{if(command.action==='cancel-uninstall')await writeFile(process.env.RIG_ROOT+'/cancelled','yes');return {ready:true}}});process.removeAllListeners('SIGTERM');process.on('SIGTERM',()=>{});`,
  );
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, script],
    mode: "process",
    userHome: root,
    stopTimeoutMs: 100,
  });
  try {
    await admin.install();
    await expect(admin.uninstall()).rejects.toMatchObject({
      code: "DAEMON_STOP",
    });
    expect(await readFile(join(root, "cancelled"), "utf8")).toBe("yes");
    expect(await admin.status()).toEqual({
      installed: true,
      running: true,
      reachable: true,
    });
  } finally {
    try {
      const owner = JSON.parse(
        await readFile(join(root, "daemon", "owner.json"), "utf8"),
      );
      process.kill(owner.pid, "SIGKILL");
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("failed initial reconciliation shuts down and releases only owned daemon evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-start-failure-"));
  const script = join(root, "child.ts");
  await mkdir(join(root, "auth"));
  await writeFile(join(root, "auth", "control-plane.token"), "test-secret");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/host.ts"))}; import {writeFile} from 'node:fs/promises'; await runDaemonHost({root:process.env.RIG_ROOT!,port:0,handle:async()=>({}),start:async()=>{throw new Error('reconciliation failure')},shutdown:async()=>{await writeFile(process.env.RIG_ROOT+'/shutdown','yes')}});`,
  );
  const child = Bun.spawn([process.execPath, script], {
    cwd: root,
    env: { ...process.env, RIG_ROOT: root },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    expect(await child.exited).toBe(1);
    expect(await readFile(join(root, "shutdown"), "utf8")).toBe("yes");
    await expect(
      readFile(join(root, "daemon", "owner.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, "daemon", "address.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(root, "auth", "control-plane.token"), "utf8"),
    ).toBe("test-secret");
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected recovery readiness preserves daemon installation and credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-recovery-"));
  const script = join(root, "child.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/host.ts"))};
     import { RigError } from ${JSON.stringify(join(import.meta.dir, "../src/domain/errors.ts"))};
     import { access } from 'node:fs/promises';
     await runDaemonHost({root:process.env.RIG_ROOT!,port:0,shutdown:async()=>{},handle:async(command)=>{
       if(command.action==='prepare-uninstall') {
         try { await access(process.env.RIG_ROOT+'/recovered'); }
         catch { throw new RigError('DEPLOY_RECOVERY','Cannot uninstall rigd while Targets have unresolved deployment recovery.','Run rig down for each affected Target to finish recovery, then retry uninstall.'); }
       }
       return {ready:true};
     }});`,
  );
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, script],
    mode: "process",
    userHome: root,
  });
  try {
    await admin.install();
    const installationPath = join(root, "daemon", "install.json");
    const tokenPath = join(root, "auth", "control-plane.token");
    const installation = await readFile(installationPath, "utf8");
    const token = await readFile(tokenPath, "utf8");
    await expect(admin.uninstall()).rejects.toMatchObject({
      code: "DEPLOY_RECOVERY",
      hint: expect.stringContaining("rig down"),
    });
    expect(await admin.status()).toEqual({
      installed: true,
      running: true,
      reachable: true,
    });
    expect(await readFile(installationPath, "utf8")).toBe(installation);
    expect(await readFile(tokenPath, "utf8")).toBe(token);
    await writeFile(join(root, "recovered"), "yes");
    await expect(admin.uninstall()).resolves.toMatchObject({
      outcome: "uninstalled",
      installed: false,
      running: false,
      reachable: false,
    });
  } finally {
    await writeFile(join(root, "recovered"), "yes");
    await admin.uninstall().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

import { spawn, type ChildProcess } from "node:child_process";
import { symlink } from "node:fs/promises";
import { inspectHost } from "../src/adapters/host-inspection";
import { renderResult } from "../src/cli/output";
import { stableExecutablePath } from "../src/cli/entry-environment";

async function daemonScript(root: string): Promise<string> {
  const script = join(root, "child.ts");
  const hostModule = join(import.meta.dir, "../src/daemon/host.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(hostModule)}; await runDaemonHost({root:process.env.RIG_ROOT!,handle:async()=>({ready:true}),shutdown:async()=>{},port:0});`,
  );
  return script;
}
/** Stands in for launchd: bootstrap starts the job's program, bootout stops it; nothing touches the real launchd. */
function fakeLaunchd(root: string, script: string, failure?: string) {
  const calls: string[][] = [];
  let child: ChildProcess | undefined;
  return {
    calls,
    async launchctl(args: readonly string[]) {
      calls.push([...args]);
      if (args[0] === "bootstrap") {
        if (failure) return { code: 5, stderr: failure };
        child = spawn(process.execPath, [script], {
          env: { ...process.env, RIG_ROOT: root, RIG_DAEMON_CHILD: "1" },
          detached: true,
          stdio: "ignore",
        });
        await new Promise((resolve) => child!.once("spawn", resolve));
        child.unref();
        return { code: 0, stderr: "" };
      }
      if (args[0] === "bootout") {
        if (!child) return { code: 3, stderr: "Boot-out failed: 3: No such process" };
        try {
          process.kill(child.pid!, "SIGTERM");
        } catch {}
        child = undefined;
        return { code: 0, stderr: "" };
      }
      return { code: 0, stderr: "" };
    },
  };
}
const label = (root: string) => `com.b-relay.rigd.${Bun.hash(root).toString(16)}`;

test("launchd install is crash-only and throttled, and a failed bootstrap reports launchctl's reason and leaves nothing installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-launchd-"));
  const script = await daemonScript(root);
  const plist = join(root, "Library", "LaunchAgents", `${label(root)}.plist`);
  try {
    const broken = fakeLaunchd(root, script, "Bootstrap failed: 5: Input/output error");
    const failing = new DaemonAdmin({
      root,
      command: [process.execPath, script],
      mode: "launchd",
      userHome: root,
      uid: 501,
      launchctl: broken.launchctl,
    });
    await expect(failing.install()).rejects.toMatchObject({
      code: "LAUNCHD",
      message: expect.stringContaining("Input/output error"),
      details: { code: 5, stderr: expect.stringContaining("Input/output error") },
    });
    await expect(readFile(plist)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await failing.status()).toMatchObject({ installed: false, running: false, reachable: false });

    const launchd = fakeLaunchd(root, script);
    const admin = new DaemonAdmin({
      root,
      command: [process.execPath, script],
      mode: "launchd",
      userHome: root,
      uid: 501,
      launchctl: launchd.launchctl,
    });
    try {
      expect(await admin.install()).toMatchObject({ outcome: "installed", reachable: true });
      const content = await readFile(plist, "utf8");
      expect(content).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
      expect(content).toContain("<key>ThrottleInterval</key><integer>10</integer>");
      expect(content).toContain(`<string>${process.execPath}</string><string>${script}</string>`);
      expect(launchd.calls.at(-1)).toEqual(["bootstrap", "gui/501", plist]);
      expect(await admin.uninstall()).toMatchObject({ outcome: "uninstalled", installed: false });
      expect(launchd.calls.at(-1)).toEqual(["bootout", `gui/501/${label(root)}`]);
      await expect(readFile(plist)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await launchd.launchctl(["bootout", `gui/501/${label(root)}`]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a launchd job that never became reachable can be uninstalled and status names its missing executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-stuck-"));
  const plist = join(root, "Library", "LaunchAgents", `${label(root)}.plist`);
  try {
    await mkdir(join(root, "daemon"), { recursive: true });
    await mkdir(join(root, "Library", "LaunchAgents"), { recursive: true });
    const command = [join(root, "Cellar", "bun"), join(root, "rigd.ts")];
    await writeFile(join(root, "daemon", "install.json"), JSON.stringify({ mode: "launchd", command }));
    await writeFile(plist, "<plist/>");
    const launchd = fakeLaunchd(root, "");
    const admin = new DaemonAdmin({
      root,
      command,
      mode: "launchd",
      userHome: root,
      uid: 501,
      launchctl: launchd.launchctl,
    });
    const status = await admin.status();
    expect(status).toMatchObject({ installed: true, running: false, reachable: false });
    expect(status.warnings).toHaveLength(1);
    expect(status.warnings?.[0]).toContain(command[0]!);
    expect(renderResult("daemon-status", status)).toContain(`Warning: ${status.warnings?.[0]}`);
    const doctor = (await inspectHost(root)).find((check) => check.name === "daemon-executable");
    expect(doctor).toMatchObject({ ok: false, reason: "missing-executable" });
    expect(doctor?.message).toContain(command[0]!);

    expect(await admin.uninstall()).toMatchObject({
      outcome: "uninstalled",
      installed: false,
      warnings: [expect.stringContaining("not reachable")],
    });
    expect(launchd.calls).toEqual([["bootout", `gui/501/${label(root)}`]]);
    await expect(readFile(plist)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "daemon", "install.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the daemon command prefers the PATH entry that resolves to the running executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-exec-"));
  try {
    await mkdir(join(root, "cellar"));
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "other"));
    await symlink(process.execPath, join(root, "cellar", "bun"));
    await symlink(join(root, "cellar", "bun"), join(root, "bin", "bun"));
    await writeFile(join(root, "other", "bun"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await stableExecutablePath(process.execPath, join(root, "bin"))).toBe(join(root, "bin", "bun"));
    expect(await stableExecutablePath(process.execPath, join(root, "other"))).toBe(process.execPath);
    expect(await stableExecutablePath(process.execPath, join(root, "empty"))).toBe(process.execPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a startup lock left by a dead or replaced startup is reclaimed; a live or recent holder is refused with the lock named and the failure recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-guard-"));
  const script = join(root, "child.ts");
  const guard = join(root, "daemon", "acquiring");
  await mkdir(join(root, "daemon"), { recursive: true });
  await mkdir(join(root, "auth"));
  await writeFile(join(root, "auth", "control-plane.token"), "test-secret");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/host.ts"))}; await runDaemonHost({root:process.env.RIG_ROOT!,port:0,handle:async()=>({}),shutdown:async()=>{}});`,
  );
  const start = () =>
    Bun.spawn([process.execPath, script], {
      cwd: root,
      env: { ...process.env, RIG_ROOT: root },
      stdout: "ignore",
      stderr: "pipe",
    });
  const startsAndServes = async () => {
    const child = start();
    try {
      const deadline = Date.now() + 10000;
      let address: { pid: number } | undefined;
      while (!address && Date.now() < deadline) {
        address = await readFile(join(root, "daemon", "address.json"), "utf8")
          .then((text) => JSON.parse(text) as { pid: number })
          .catch(() => undefined);
        if (!address) await Bun.sleep(50);
      }
      expect(address).toMatchObject({ pid: child.pid });
    } finally {
      child.kill();
      await child.exited;
    }
    await rm(join(root, "daemon", "address.json"), { force: true });
    await rm(join(root, "daemon", "owner.json"), { force: true });
  };
  const refused = async (pattern: RegExp) => {
    const child = start();
    expect(await child.exited).not.toBe(0);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("DAEMON_START_LOCK");
    expect(stderr).toContain(guard);
    expect(stderr).toMatch(pattern);
    expect(
      JSON.parse(await readFile(join(root, "daemon", "startup-failure.json"), "utf8")),
    ).toMatchObject({ code: "DAEMON_START_LOCK", hint: expect.stringContaining(guard) });
    await rm(guard, { recursive: true, force: true });
  };
  try {
    // Holder replaced by another process: reclaimed.
    await mkdir(guard);
    await writeFile(
      join(guard, "holder.json"),
      JSON.stringify({ pid: process.pid, startedAt: "Thu Jan  1 00:00:00 1970" }),
    );
    await startsAndServes();
    // Holder exited: reclaimed.
    await mkdir(guard);
    await writeFile(join(guard, "holder.json"), JSON.stringify({ pid: 2147483647, startedAt: "x" }));
    await startsAndServes();
    // No holder record (older rigd) and old: reclaimed.
    await mkdir(guard);
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(guard, old, old);
    await startsAndServes();
    // Live holder: refused, naming pid and lock.
    await mkdir(guard);
    await writeFile(join(guard, "holder.json"), JSON.stringify({ pid: process.pid }));
    await refused(new RegExp(`pid ${process.pid}`));
    // No holder record and recent: refused.
    await mkdir(guard);
    await refused(/begun less than/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("install reports the daemon's own startup failure as soon as it is recorded instead of a generic timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-startfail-"));
  const script = join(root, "child.ts");
  const guard = join(root, "daemon", "acquiring");
  await mkdir(guard, { recursive: true });
  await writeFile(join(guard, "holder.json"), JSON.stringify({ pid: process.pid }));
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/host.ts"))}; await runDaemonHost({root:process.env.RIG_ROOT!,port:0,handle:async()=>({}),shutdown:async()=>{}});`,
  );
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, script],
    mode: "process",
    userHome: root,
  });
  try {
    const began = Date.now();
    const error = await admin.install().then(() => undefined, (error: unknown) => error);
    expect(Date.now() - began).toBeLessThan(4000);
    expect(error).toMatchObject({
      code: "DAEMON_START",
      message: expect.stringContaining("Another startup owns the daemon acquisition lock"),
      hint: expect.stringContaining(guard),
      details: { startup: { code: "DAEMON_START_LOCK" } },
    });
    expect(await admin.status()).toMatchObject({ installed: false, running: false });
  } finally {
    await admin.uninstall().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
