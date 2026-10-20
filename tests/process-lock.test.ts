import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireProcessLock,
  type LockHeld,
} from "../src/adapters/process-lock";
import { processStartTime } from "../src/daemon/process-identity";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rig-process-lock-"));
  roots.push(root);
  return join(root, "work.lock");
}
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test("contenders for a lock a crashed holder left behind never hold it at once", async () => {
  const path = await lockPath();
  for (let round = 0; round < 40; round++) {
    await writeFile(path, JSON.stringify({ pid: 2147483647 }));
    const results = await Promise.all(
      Array.from({ length: 4 }, () => acquireProcessLock(path)),
    );
    const holders = results.flatMap((result) =>
      "lock" in result ? [result.lock] : [],
    );
    expect(holders).toHaveLength(1);
    for (const result of results)
      if ("held" in result) expect(result.held.lockPath).toBe(path);
    for (const holder of holders) await holder.release();
  }
});

test("processes taking one lock at once hold it one at a time", async () => {
  const path = await lockPath();
  const log = `${path}.log`;
  // Each takes the lock until it has it, records entering, holds it a moment, records leaving, and releases it.
  const contender = `
    import { appendFileSync } from "node:fs";
    import { acquireProcessLock } from ${JSON.stringify(join(import.meta.dir, "../src/adapters/process-lock.ts"))};
    const [path, log] = process.argv.slice(2);
    for (let taken = 0; taken < 5; ) {
      const acquired = await acquireProcessLock(path);
      if (!("lock" in acquired)) { await Bun.sleep(1); continue; }
      appendFileSync(log, "in\\n");
      await Bun.sleep(2);
      appendFileSync(log, "out\\n");
      await acquired.lock.release();
      taken++;
    }`;
  const script = `${path}.ts`;
  await writeFile(script, contender);
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, script, path, log], { stderr: "inherit" }),
  );
  expect(await Promise.all(children.map((child) => child.exited))).toEqual([
    0, 0, 0, 0,
  ]);
  const entries = (await readFile(log, "utf8")).trim().split("\n");
  expect(entries).toHaveLength(40);
  // Strictly alternating: no one entered while another held the lock.
  entries.forEach((entry, index) =>
    expect(entry).toBe(index % 2 === 0 ? "in" : "out"),
  );
  expect(await exists(path)).toBe(false);
}, 30000);

test("a lock held by a running process is refused with its pid, and taken as soon as that process dies", async () => {
  const path = await lockPath();
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { acquireProcessLock } = await import(${JSON.stringify(join(import.meta.dir, "../src/adapters/process-lock.ts"))});
       const acquired = await acquireProcessLock(${JSON.stringify(path)});
       if (!("lock" in acquired)) process.exit(1);
       console.log("held");
       await Bun.sleep(60000);`,
    ],
    { stdout: "pipe" },
  );
  const reader = holder.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "held",
  );
  expect(await acquireProcessLock(path)).toEqual({
    held: { lockPath: path, pid: holder.pid },
  });
  // Killed without releasing: the kernel drops its lock; the file it left names a process that is gone.
  holder.kill("SIGKILL");
  await holder.exited;
  const acquired = await acquireProcessLock(path);
  expect("lock" in acquired).toBe(true);
  if ("lock" in acquired) await acquired.lock.release();
});

test("whatever an unlocked lock file records, it is taken: a dead or replaced holder, or nothing readable", async () => {
  const path = await lockPath();
  for (const content of [
    JSON.stringify({ pid: 2147483647 }),
    JSON.stringify({ pid: process.pid, startedAt: "Thu Jan  1 00:00:00 1970" }),
    "{torn",
    "",
  ]) {
    await writeFile(path, content);
    const acquired = await acquireProcessLock(path);
    if (!("lock" in acquired)) throw new Error(`refused ${content}`);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      pid: process.pid,
    });
    await acquired.lock.release();
    expect(await exists(path)).toBe(false);
  }
});

test("a lock file an older rig created for a process still running is held by it, with or without its start time", async () => {
  const path = await lockPath();
  const older = Bun.spawn(["/bin/sleep", "30"]);
  try {
    const startedAt = await processStartTime(older.pid);
    for (const record of [{ pid: older.pid, startedAt }, { pid: older.pid }]) {
      await writeFile(path, JSON.stringify(record));
      expect(await acquireProcessLock(path)).toEqual({
        held: { lockPath: path, pid: older.pid },
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(record);
    }
  } finally {
    older.kill();
    await older.exited;
  }
  const acquired = await acquireProcessLock(path);
  expect("lock" in acquired).toBe(true);
  if ("lock" in acquired) await acquired.lock.release();
});

test("release removes only this lock's own file, never one put in its place", async () => {
  const path = await lockPath();
  const acquired = await acquireProcessLock(path);
  if (!("lock" in acquired)) throw new Error("refused");
  await rename(path, `${path}.moved`);
  await writeFile(path, "another's");
  await acquired.lock.release();
  expect(await readFile(path, "utf8")).toBe("another's");
  // Released twice, still nothing else is touched.
  await acquired.lock.release();
  expect(await readFile(path, "utf8")).toBe("another's");
});

test("a kept lock stays as an empty file, and is the lock lockf(1) takes", async () => {
  const path = await lockPath();
  const lockf = (command: string[]) =>
    Bun.spawn(["/usr/bin/lockf", "-s", "-t", "0", path, ...command]).exited;
  const acquired = await acquireProcessLock(path, { keep: true });
  if (!("lock" in acquired)) throw new Error("refused");
  // EX_TEMPFAIL: already locked.
  expect(await lockf(["/usr/bin/true"])).toBe(75);
  await acquired.lock.release();
  expect(await readFile(path, "utf8")).toBe("");
  // Held by lockf, it is refused here, naming the pid the holder recorded.
  const holder = Bun.spawn([
    "/usr/bin/lockf",
    "-k",
    path,
    "/bin/sh",
    "-c",
    `printf '{"pid":%s}' $$ > '${path}'; exec /bin/sleep 30`,
  ]);
  let held: LockHeld | undefined;
  try {
    for (let attempt = 0; attempt < 100 && !held; attempt++) {
      const result = await acquireProcessLock(path, { keep: true });
      if ("lock" in result) await result.lock.release();
      else if (result.held.pid) held = result.held;
      await Bun.sleep(20);
    }
    expect(held).toEqual({ lockPath: path, pid: expect.any(Number) });
  } finally {
    if (held?.pid) process.kill(held.pid);
    await holder.exited;
  }
});

test("an acquisition whose lock file a releasing holder removed meanwhile does not hold the lock beside the next holder", async () => {
  const path = await lockPath();
  // In a process of its own, the path is swapped just after this acquisition opened and locked the file: its holder
  // releases (removes the file), and the next holder creates and locks a new one there.
  const script = `${path}.ts`;
  await writeFile(
    script,
    `import { mock } from "bun:test";
     import * as fs from "node:fs/promises";
     import { constants } from "node:fs";
     const path = process.argv[2];
     const { lstat, open, unlink } = fs;
     let next;
     mock.module("node:fs/promises", () => ({
       ...fs,
       lstat: async (target, ...rest) => {
         if (target === path && !next) {
           await unlink(path);
           next = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | 0x20, 0o600);
         }
         return lstat(target, ...rest);
       },
     }));
     const { acquireProcessLock } = await import(${JSON.stringify(join(import.meta.dir, "../src/adapters/process-lock.ts"))});
     const acquired = await acquireProcessLock(path);
     process.stdout.write("lock" in acquired ? "held both" : "refused");`,
  );
  const child = Bun.spawn([process.execPath, script, path], {
    stdout: "pipe",
  });
  expect(await new Response(child.stdout).text()).toBe("refused");
  expect(await child.exited).toBe(0);
});
