import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonAdmin } from "../src/daemon/admin";

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

test("owner evidence without an address reports a running but unreachable daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-owner-"));
  try {
    await mkdir(join(root, "daemon"));
    await writeFile(
      join(root, "daemon", "owner.json"),
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
    });
    await expect(admin.install()).rejects.toMatchObject({
      code: "DAEMON_UNREACHABLE",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
