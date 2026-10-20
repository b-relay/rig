import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock } from "../src/adapters/process-lock";
import { DaemonAdmin } from "../src/daemon/admin";
import { installLockPath } from "../src/daemon/installation";
import type { ProxyInstallation } from "../src/daemon/proxy-installation";

const HOST = join(import.meta.dir, "../src/daemon/host.ts");
const IDENTITY = join(import.meta.dir, "../src/daemon/process-identity.ts");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const script = join(root, "child.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(HOST)}; await runDaemonHost({root:process.env.RIG_ROOT!,handle:async()=>({ready:true}),shutdown:async()=>{},port:0});`,
  );
  return {
    root,
    admin: (options: Partial<ConstructorParameters<typeof DaemonAdmin>[0]>) =>
      new DaemonAdmin({
        root,
        command: [process.execPath, script],
        mode: "process",
        userHome: root,
        ...options,
      }),
  };
}

/** The first line a child writes. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0]!;
}

test("rigd starting twice at once over a crashed startup's lock serves once, and the lease names the one that serves", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-two-starts-"));
  roots.push(root);
  const daemon = join(root, "daemon");
  await mkdir(join(root, "auth"), { recursive: true });
  await writeFile(join(root, "auth", "control-plane.token"), "test-secret");
  // Each contender is a real startup with one pause at an existing await. The first, once it holds the startup lock,
  // takes 300 ms to check the lease, as a slow ps would. The second, should it find a crashed startup's lock and check
  // that holder, waits until the first has gone in; a startup that could take the lock from under the first would then.
  const contender = join(root, "contender.ts");
  await writeFile(
    contender,
    `import { existsSync, writeFileSync } from "node:fs";
     import { mock } from "bun:test";
     import * as real from ${JSON.stringify(IDENTITY)};
     const [root, go, entered] = process.argv.slice(2);
     const role = process.env.ROLE;
     const { recordedProcess, processStartTime, processExists } = real;
     mock.module(${JSON.stringify(IDENTITY)}, () => ({
       processExists,
       processStartTime,
       recordedProcess: async (record) => {
         const lease = "instanceId" in record;
         if (role === "first" && lease) { writeFileSync(entered, ""); await Bun.sleep(300); }
         if (role === "second" && !lease)
           for (let i = 0; i < 100 && !existsSync(entered); i++) await Bun.sleep(10);
         return recordedProcess(record);
       },
     }));
     const { runDaemonHost } = await import(${JSON.stringify(HOST)});
     while (!existsSync(go)) await Bun.sleep(1);
     try {
       await runDaemonHost({ root, port: 0, handle: async () => ({}), shutdown: async () => {},
         start: async () => { process.stdout.write("SERVING\\n"); } });
     } catch (error) {
       process.stdout.write("REFUSED " + error.code + "\\n");
       process.exit(0);
     }`,
  );
  const crashed = {
    pid: 2147483647,
    startedAt: "Thu Jan  1 00:00:00 2026",
  };
  for (let round = 0; round < 5; round++) {
    await rm(daemon, { recursive: true, force: true });
    // What a crashed rigd leaves: its lease, and a startup lock in this rigd's form and an older one's.
    await mkdir(join(daemon, "acquiring"), { recursive: true });
    await writeFile(
      join(daemon, "acquiring", "holder.json"),
      JSON.stringify(crashed),
    );
    await writeFile(join(daemon, "acquiring.lock"), JSON.stringify(crashed));
    await writeFile(
      join(daemon, "owner.json"),
      JSON.stringify({ ...crashed, instanceId: crypto.randomUUID() }),
    );
    const go = join(root, `go-${round}`),
      entered = join(root, `entered-${round}`);
    const start = (role: string) =>
      Bun.spawn([process.execPath, contender, root, go, entered], {
        env: { ...process.env, RIG_ROOT: root, ROLE: role },
        stdout: "pipe",
        stderr: "ignore",
      });
    const children = [start("first"), start("second")];
    try {
      await writeFile(go, "");
      const said = await Promise.all(
        children.map((child) => firstLine(child.stdout)),
      );
      const serving = children.filter((_, index) => said[index] === "SERVING");
      expect(serving).toHaveLength(1);
      for (const line of said)
        expect(line).toMatch(
          /^(SERVING|REFUSED DAEMON_START_LOCK|REFUSED DAEMON_RUNNING)$/,
        );
      expect(
        JSON.parse(await readFile(join(daemon, "owner.json"), "utf8")),
      ).toMatchObject({ pid: serving[0]!.pid });
      // A later startup finds it serving.
      const later = start("later");
      children.push(later);
      expect(await firstLine(later.stdout)).toBe("REFUSED DAEMON_RUNNING");
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  }
}, 60000);

test("rigd install twice at once: the second is refused while the first runs, and the first's rigd, credential and installation stay", async () => {
  const f = await fixture("rig-two-installs-");
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  // The first install pauses as it asks how routes are published, after it has looked at what runs.
  const proxy = {
    mode: async () => {
      entered.resolve();
      await resume.promise;
      return "external" as const;
    },
    remove: async () => {},
  } as unknown as ProxyInstallation;
  const first = f.admin({ proxy });
  const second = f.admin({});
  const firstInstall = first.install().then(
    (status) => status,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    for (const action of [() => second.install(), () => second.uninstall()])
      await expect(action()).rejects.toMatchObject({
        code: "DAEMON_INSTALL_LOCKED",
        hint: expect.stringContaining(installLockPath(f.root)),
      });
    resume.resolve();
    expect(await firstInstall).toMatchObject({
      outcome: "installed",
      reachable: true,
    });
    // One rigd serves, reachable with the credential on disk, and its installation is recorded.
    expect(await second.status()).toMatchObject({
      installed: true,
      running: true,
      reachable: true,
    });
    expect(
      JSON.parse(
        await readFile(join(f.root, "daemon", "install.json"), "utf8"),
      ),
    ).toMatchObject({ mode: "process" });
    // Once the first is done, the second goes ahead.
    expect(await second.install()).toMatchObject({ outcome: "unchanged" });
  } finally {
    resume.resolve();
    await firstInstall;
    await second.uninstall().catch(() => {});
  }
}, 30000);

test("rigd install goes ahead under the installation lock only when the process that ran it holds it", async () => {
  const f = await fixture("rig-install-under-installer-");
  await mkdir(join(f.root, "daemon"), { recursive: true });
  const held = await acquireProcessLock(installLockPath(f.root), {
    keep: true,
  });
  if (!("lock" in held)) throw new Error("refused");
  try {
    await expect(f.admin({}).install()).rejects.toMatchObject({
      code: "DAEMON_INSTALL_LOCKED",
      details: { pid: process.pid },
    });
    // Run by the release installer that holds it.
    expect(await f.admin({ parent: process.pid }).install()).toMatchObject({
      outcome: "installed",
      reachable: true,
    });
  } finally {
    await held.lock.release();
    await f.admin({}).uninstall();
  }
}, 30000);
