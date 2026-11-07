import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { runCommand } from "../src/providers/command-runner";
import { createProcessIdentityReader } from "../src/providers/process-identity";
import { processLeasePath } from "../src/providers/process-lease";
import {
  daemonIdentity,
  processExited,
  processIdentity,
  recordedDaemon,
  rigFixture,
} from "./support/rig-fixture";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
/** What the process `pid` runs now, or "" once it is gone. */
function commandOf(pid: number): string {
  return Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "ignore",
  }).stdout.toString();
}
/** Stops `owned` if it is still the process it was, and fails when it will not go: a test's last word on what it started. */
async function stopOwned(owned: { pid: number; identity: string } | undefined) {
  if (owned === undefined || processIdentity(owned.pid) !== owned.identity)
    return;
  process.kill(owned.pid, "SIGTERM");
  if (!(await processExited(owned))) process.kill(owned.pid, "SIGKILL");
  if (!(await processExited(owned)))
    throw new Error(`process ${owned.pid} is still running`);
}

test("a fixture whose record cannot be read still stops its rigd, keeps its root as it was, and fails saying why", async () => {
  const f = await rigFixture();
  let daemon: Awaited<ReturnType<typeof recordedDaemon>>;
  try {
    const installed = await f.rigd(["install"]);
    // Known before anything is asserted, so the finally below can stop it whatever fails.
    daemon = await recordedDaemon(f.root);
    expect(installed.code).toBe(0);
    expect(daemon).toBeDefined();
    // What a failed assertion can leave behind: a record neither rig down nor rigd uninstall can read.
    const state = join(f.root, "runtime", "state.json");
    await writeFile(state, "{broken");
    const failure = await f.cleanup().then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toContain(`its root is kept at ${f.base}:`);
    expect(failure).toContain("its Targets could not be read");
    expect(failure).toContain("rigd uninstall exited with 1:");
    // Asked to stop, it stopped: it never had to be killed.
    expect(failure).not.toContain("did not stop");
    expect(await processExited(daemon!)).toBe(true);
    expect(await readFile(state, "utf8")).toBe("{broken");
  } finally {
    // The root goes only once the rigd it served is confirmed gone; otherwise it stays, and the test fails saying so.
    daemon ??= await recordedDaemon(f.root);
    if (
      daemon !== undefined &&
      daemonIdentity(daemon.pid) === daemon.identity
    ) {
      process.kill(daemon.pid, "SIGTERM");
      if (!(await processExited(daemon))) process.kill(daemon.pid, "SIGKILL");
      if (!(await processExited(daemon)))
        throw new Error(
          `rigd ${daemon.pid} is still running; its root is kept at ${f.base}`,
        );
    }
    await rm(f.base, { recursive: true, force: true });
  }
}, 60_000);

test("a fixture whose record cannot be read still stops the Services its leases name, and waits for them, before it fails", async () => {
  const f = await rigFixture();
  let daemon: Awaited<ReturnType<typeof recordedDaemon>>;
  let service: { pid: number; identity: string }[] = [];
  try {
    await writeFile(
      join(f.repo, "rig.yaml"),
      "name: demo\nservices:\n  api:\n    command: sleep 120\ntargets:\n  working: true\n",
    );
    const installed = await f.rigd(["install"]);
    daemon = await recordedDaemon(f.root);
    expect(installed.code).toBe(0);
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    expect(await f.rig(["up"])).toMatchObject({ code: 0 });
    const status = JSON.parse(
      (await f.rig(["status", "--project", "demo", "--json"])).stdout,
    ) as { targets: { name: string; components: { pid?: number }[] }[] };
    const wrapper = status.targets.find((target) => target.name === "working")
      ?.components[0]?.pid;
    expect(wrapper).toBeNumber();
    // The Service is its capture wrapper and the application the wrapper runs.
    const application = Bun.spawnSync(["pgrep", "-P", String(wrapper)])
      .stdout.toString()
      .trim();
    service = [wrapper!, Number(application)].map((pid) => ({
      pid,
      identity: processIdentity(pid) ?? "",
    }));
    expect(commandOf(service[1]!.pid)).toContain("sleep 120");
    // With its record unreadable, nothing can ask rigd to stop the Service: only what the fixture tracks apart from it.
    await writeFile(join(f.root, "runtime", "state.json"), "{broken");
    const failure = await f.cleanup().then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toContain(`its root is kept at ${f.base}:`);
    expect(failure).toContain("its Targets could not be read");
    expect(failure).toContain("outlived rigd, and were stopped");
    // Gone by the time cleanup answers, not just signalled.
    expect(service.map(({ pid }) => processIdentity(pid))).toEqual([
      undefined,
      undefined,
    ]);
  } finally {
    for (const owned of service) await stopOwned(owned);
    await stopOwned(daemon ?? (await recordedDaemon(f.root)));
    await rm(f.base, { recursive: true, force: true });
  }
}, 60_000);

/** A fixture whose rigd is a script: with `released`, a shell condition, `rigd uninstall` releases the shell `leasedShell`
 * started and returns once the condition holds; without it, it does nothing. Nothing else runs, so the test is of what
 * cleanup does with the root's leases alone. */
async function scriptedFixture(work: string, released?: string) {
  const fifo = join(work, "release");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const rigd = join(work, "rigd");
  await writeFile(
    rigd,
    `#!/bin/sh
[ "$1" = uninstall ] || exit 0
${
  released === undefined
    ? "exit 0"
    : `echo go > '${fifo}'
for _ in $(seq 200); do ${released} && exit 0; sleep 0.05; done
exit 1`
}
`,
    { mode: 0o755 },
  );
  return {
    fifo,
    fixture: await rigFixture({
      commands: { rig: ["/usr/bin/true"], rigd: [rigd] },
    }),
  };
}
/** Starts `script` in a shell that leads its own process group, as rigd starts a Service, and leases it in `root` as rigd
 * would. The lease records `identity` when given, otherwise the process's own. */
async function leasedShell(root: string, script: string, identity?: string) {
  const child = spawn("/bin/sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid!;
  const birth = processIdentity(pid);
  expect(birth).toBeDefined();
  const key = `fixture-test:${pid}`;
  await mkdir(join(root, "process-leases"), { recursive: true });
  await writeFile(
    processLeasePath(root, key),
    JSON.stringify({
      key,
      pid,
      identity:
        identity ?? (await createProcessIdentityReader(runCommand)(pid)),
    }),
  );
  return { pid, identity: birth! };
}
/** The fixture's cleanup failure, or undefined when it succeeded. */
const cleanupFailure = (cleanup: () => Promise<void>) =>
  cleanup().then(
    () => undefined,
    (error: Error) => error.message,
  );

test("a leased process that execs into another program during teardown is still the fixture's: it is stopped before the root goes", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-exec-"));
  const owned: { pid: number; identity: string }[] = [];
  let base: string | undefined;
  try {
    const shell = join(work, "shell.pid");
    const { fifo, fixture } = await scriptedFixture(
      work,
      `ps -p "$(cat '${shell}')" -o command= | grep -q 'sleep 120'`,
    );
    base = fixture.base;
    const leased = await leasedShell(
      fixture.root,
      `read _ < '${fifo}'; exec /bin/sleep 120`,
    );
    owned.push(leased);
    await writeFile(shell, String(leased.pid));
    const failure = await cleanupFailure(fixture.cleanup);
    // The same pid and birth, now running sleep: the process the lease named, stopped and gone before cleanup answered.
    expect(failure).toContain(`its root is kept at ${fixture.base}:`);
    expect(failure).toContain(`${leased.pid} (/bin/sleep 120)`);
    expect(processIdentity(leased.pid)).toBeUndefined();
    expect(await exists(fixture.root)).toBe(true);
  } finally {
    for (const each of owned) await stopOwned(each);
    if (base) await rm(base, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

test("a process a leased group starts during teardown, once its leader is gone, keeps the root and fails the cleanup", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-fork-"));
  const owned: { pid: number; identity: string }[] = [];
  let base: string | undefined;
  try {
    const shell = join(work, "shell.pid");
    const child = join(work, "child.pid");
    const { fifo, fixture } = await scriptedFixture(
      work,
      `[ -s '${child}' ] && ! ps -p "$(cat '${shell}')" > /dev/null`,
    );
    base = fixture.base;
    const leased = await leasedShell(
      fixture.root,
      `read _ < '${fifo}'; /bin/sleep 120 & echo $! > '${child}'; exit 0`,
    );
    owned.push(leased);
    await writeFile(shell, String(leased.pid));
    const failure = await cleanupFailure(fixture.cleanup);
    const forked = Number(await readFile(child, "utf8"));
    const birth = processIdentity(forked);
    if (birth) owned.push({ pid: forked, identity: birth });
    // Born after the lease was read, into a group whose leader has gone: nothing proves it is the fixture's to signal, so it
    // is named, and the root is kept.
    expect(failure).toContain(`its root is kept at ${fixture.base}:`);
    expect(failure).toContain(`${forked} (/bin/sleep 120)`);
    expect(birth).toBeDefined();
    expect(await exists(fixture.root)).toBe(true);
  } finally {
    for (const each of owned) await stopOwned(each);
    if (base) await rm(base, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

test("a lease whose pid now belongs to another process never has that process signalled", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-stranger-"));
  const owned: { pid: number; identity: string }[] = [];
  let base: string | undefined;
  try {
    const { fixture } = await scriptedFixture(work);
    base = fixture.base;
    // The lease's pid, reused: a live group leader, but not born when the lease says.
    const stranger = await leasedShell(
      fixture.root,
      "exec /bin/sleep 120",
      createHash("sha256").update("1:Thu Jan  1 00:00:00 1970").digest("hex"),
    );
    owned.push(stranger);
    const failure = await cleanupFailure(fixture.cleanup);
    expect(failure).toContain(`its root is kept at ${fixture.base}:`);
    expect(failure).toContain(`${stranger.pid} (/bin/sleep 120)`);
    // Still running, as the same process: the fixture sent it nothing.
    expect(processIdentity(stranger.pid)).toBe(stranger.identity);
  } finally {
    for (const each of owned) await stopOwned(each);
    if (base) await rm(base, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);
