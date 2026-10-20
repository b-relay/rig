import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileStateStore } from "../src/runtime/state-store";
import { DaemonAdmin } from "../src/daemon/admin";
import { securePrivateRoot } from "../src/daemon/private-root";
import { readCaptureRequest } from "../src/providers/capture-request";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { createProcessTiming } from "../src/providers/process-timing";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { runCommand } from "../src/providers/command-runner";
import { accessKey } from "../web/server/access-key";
import * as fsp from "node:fs/promises";
import { createFileDiagnosticLog } from "../src/diagnostics/file-log";
import { openSqliteUsageHistory } from "../src/adapters/sqlite-usage-history";
import { writeEnvFile } from "../src/adapters/env-store";
import { ABSENT_REVISION } from "../src/adapters/env-file-edit";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
/** A Rig root and, beside it, a directory standing for everything outside it, holding one file a link can point at. */
async function layout() {
  const base = await mkdtemp(join(tmpdir(), "rig-private-root-"));
  roots.push(base);
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root, { mode: 0o700 });
  await mkdir(outside);
  const target = join(outside, "target");
  await writeFile(target, "outside\n", { mode: 0o644 });
  return { base, root, outside, target };
}
const mode = async (path: string) => (await lstat(path)).mode & 0o777;
/** Everything outside the root, as it is now. */
async function snapshot(outside: string) {
  const files: Record<string, string> = {};
  for (const name of (await readdir(outside)).sort())
    files[name] =
      `${await readFile(join(outside, name), "utf8")} ${await mode(join(outside, name))}`;
  return files;
}

test("runtime state is never written through a link planted at its temporary path or at state.json", async () => {
  const { root, outside, target } = await layout();
  await mkdir(join(root, "runtime"), { mode: 0o700 });
  // The temporary path earlier versions always used, and the state file itself.
  await symlink(target, join(root, "runtime", "state.json.next"));
  const before = await snapshot(outside);
  const store = new FileStateStore(root);
  await store.update(() => {});
  expect(await snapshot(outside)).toEqual(before);

  // A link at state.json itself, to a state document outside: replaced by the next write, the document left as it was.
  const document = join(outside, "state.json");
  await writeFile(
    document,
    await readFile(join(root, "runtime", "state.json"), "utf8"),
    { mode: 0o644 },
  );
  await rm(join(root, "runtime", "state.json"));
  await symlink(document, join(root, "runtime", "state.json"));
  const linked = await snapshot(outside);
  await store.update((state) => {
    state.activity = [];
  });
  expect(await snapshot(outside)).toEqual(linked);
  expect((await lstat(join(root, "runtime", "state.json"))).isFile()).toBe(
    true,
  );
  expect(await mode(join(root, "runtime", "state.json"))).toBe(0o600);
});

test("a runtime directory replaced by a link is refused, and nothing is written where it leads", async () => {
  const { root, outside } = await layout();
  await symlink(outside, join(root, "runtime"));
  const before = await snapshot(outside);
  await expect(new FileStateStore(root).update(() => {})).rejects.toMatchObject(
    {
      code: "RIG_ROOT_UNSAFE",
      details: { path: join(root, "runtime") },
    },
  );
  expect(await snapshot(outside)).toEqual(before);
});

test("rigd install refuses a Rig root whose runtime directory is a link before it writes anything, Activity included", async () => {
  const { root, outside } = await layout();
  await symlink(outside, join(root, "runtime"));
  const before = await snapshot(outside);
  const admin = new DaemonAdmin({
    root,
    command: [],
    mode: "process",
    userHome: root,
  });
  await expect(admin.install()).rejects.toMatchObject({
    code: "RIG_ROOT_UNSAFE",
    details: { path: join(root, "runtime") },
  });
  expect(await snapshot(outside)).toEqual(before);
  await expect(stat(join(root, "auth"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("rigd install replaces a link planted at the credential path with its own private file, leaving what it led to alone", async () => {
  const { root, outside, target } = await layout();
  await mkdir(join(root, "auth"), { mode: 0o700 });
  const token = join(root, "auth", "control-plane.token");
  await symlink(target, token);
  const before = await snapshot(outside);
  const admin = new DaemonAdmin({
    root,
    // No program: the install stops once the credential is written, before it would start rigd.
    command: [],
    mode: "process",
    userHome: root,
  });
  await expect(admin.install()).rejects.toMatchObject({
    code: "DAEMON_COMMAND",
  });
  expect(await snapshot(outside)).toEqual(before);
  expect((await lstat(token)).isFile()).toBe(true);
  expect(await mode(token)).toBe(0o600);
  expect((await readFile(token, "utf8")).length).toBeGreaterThan(20);
});

test("a sensitive directory others can write is refused at install, with the chmod that fixes it", async () => {
  const { root } = await layout();
  await mkdir(join(root, "capture"));
  await chmod(join(root, "capture"), 0o775);
  const admin = new DaemonAdmin({
    root,
    command: [],
    mode: "process",
    userHome: root,
  });
  const refused = await admin.install().catch((error) => error);
  expect(refused).toMatchObject({
    code: "RIG_ROOT_UNSAFE",
    details: {
      path: join(root, "capture"),
      problem: "can be written by other users",
    },
  });
  expect(refused.hint).toContain(`chmod 700 ${join(root, "capture")}`);
  // Refused, not silently repaired: someone else may have changed what is in it.
  expect(await mode(join(root, "capture"))).toBe(0o775);
});

test("a Rig root or sensitive directory another user owns is refused, with the chown that fixes it", async () => {
  const { root } = await layout();
  await mkdir(join(root, "daemon"), { mode: 0o700 });
  const uid = process.getuid!();
  const owner = spyOn(process, "getuid").mockImplementation(() => uid + 1);
  try {
    const refused = await securePrivateRoot(root).catch((error) => error);
    expect(refused).toMatchObject({
      code: "RIG_ROOT_UNSAFE",
      details: { path: root, problem: `is owned by uid ${uid}, not by you` },
    });
    expect(refused.hint).toContain(`sudo chown -R`);
    expect(refused.hint).toContain(root);
  } finally {
    owner.mockRestore();
  }
});

test("a sensitive directory replaced by a link is refused as rigd starts", async () => {
  const { root, outside } = await layout();
  await symlink(outside, join(root, "daemon"));
  await expect(securePrivateRoot(root)).rejects.toMatchObject({
    code: "RIG_ROOT_UNSAFE",
    details: { path: join(root, "daemon"), problem: "is a symbolic link" },
  });
});

test("a root an earlier Rig left with default modes keeps working: its directories are made private, the missing ones made 0700", async () => {
  const { root } = await layout();
  await chmod(root, 0o755);
  for (const name of ["capture", "process-leases", "logs", "bin"]) {
    await mkdir(join(root, name));
    await chmod(join(root, name), 0o755);
  }
  await writeFile(join(root, "logs", "kept.log"), "kept\n");
  await securePrivateRoot(root);
  expect(await mode(root)).toBe(0o700);
  for (const name of [
    "capture",
    "process-leases",
    "logs",
    "bin",
    "auth",
    "daemon",
    "runtime",
  ])
    expect(await mode(join(root, name))).toBe(0o700);
  expect(await readFile(join(root, "logs", "kept.log"), "utf8")).toBe("kept\n");
});

const capturePath = (root: string, key: string) =>
  join(
    root,
    "capture",
    `${createHash("sha256").update(key).digest("hex")}.json`,
  );
const wrapperScript = () =>
  `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))};process.exitCode=await runCapturedProcess(process.argv[2]!);`;

test("under umask 002 the capture directory, its request and the supervisor's directories are private, and capture works", async () => {
  const { base, root } = await layout();
  const wrapper = join(base, "capture.ts");
  await writeFile(wrapper, wrapperScript());
  const marker = join(base, "ran");
  const supervisor = createChildSupervisor({
    stateRoot: root,
    captureCommand: [process.execPath, wrapper],
    timing: createProcessTiming(),
    processInspection: createProcessInspection({
      run: runCommand,
      kill: platformKill,
    }),
  });
  const previous = process.umask(0o002);
  try {
    const started = await supervisor.ensureRunning({
      key: "web",
      componentName: "web",
      command: [
        "/bin/sh",
        "-c",
        `printf ran > ${JSON.stringify(marker)}; exec /bin/sleep 30`,
      ],
      cwd: base,
      env: { PATH: "/usr/bin:/bin" },
      logRoot: join(root, "logs", "web"),
      incarnation: "start-1",
    });
    expect(started.pid).toBeGreaterThan(0);
    for (const directory of [
      "capture",
      "process-leases",
      "logs",
      join("logs", "web"),
    ])
      expect(await mode(join(root, directory))).toBe(0o700);
    expect(await mode(capturePath(root, "web"))).toBe(0o600);
    for (let i = 0; i < 200 && !(await stat(marker).catch(() => false)); i++)
      await Bun.sleep(10);
    expect(await readFile(marker, "utf8")).toBe("ran");
  } finally {
    process.umask(previous);
    await supervisor.stop("web", { graceMs: 0 }).catch(() => {});
    await supervisor.shutdown();
  }
}, 20000);

test("the capture wrapper refuses a request others can write, or one reached through a link, and runs nothing", async () => {
  const { base, root, outside } = await layout();
  await mkdir(join(root, "capture"), { mode: 0o700 });
  const wrapper = join(base, "capture.ts");
  await writeFile(wrapper, wrapperScript());
  const marker = join(base, "ran");
  const request = (path: string) =>
    writeFile(
      path,
      JSON.stringify({
        key: "web",
        componentName: "web",
        command: ["/bin/sh", "-c", `printf ran > ${JSON.stringify(marker)}`],
        cwd: base,
        env: { PATH: "/usr/bin:/bin" },
        logRoot: join(root, "logs", "web"),
        incarnation: "start-1",
      }),
      { mode: 0o600 },
    );
  const path = capturePath(root, "web");

  await request(path);
  await chmod(path, 0o620);
  await expect(readCaptureRequest(root, path)).rejects.toMatchObject({
    code: "RIG_FILE_UNTRUSTED",
  });
  const swapped = await runCommand({
    command: [process.execPath, wrapper, path],
  });
  expect(swapped.exitCode).not.toBe(0);
  expect(swapped.stderr).toContain("can be written by other users");

  await rm(path);
  await request(join(outside, "request.json"));
  await symlink(join(outside, "request.json"), path);
  await expect(readCaptureRequest(root, path)).rejects.toMatchObject({
    code: "RIG_FILE_UNTRUSTED",
  });
  const linked = await runCommand({
    command: [process.execPath, wrapper, path],
  });
  expect(linked.exitCode).not.toBe(0);

  await rm(path);
  await request(path);
  await chmod(join(root, "capture"), 0o770);
  await expect(readCaptureRequest(root, path)).rejects.toMatchObject({
    code: "RIG_ROOT_UNSAFE",
  });

  // A request outside a capture directory names no Rig root the wrapper could check, so it is refused too.
  await request(join(base, "request.json"));
  const elsewhere = await runCommand({
    command: [process.execPath, wrapper, join(base, "request.json")],
  });
  expect(elsewhere.exitCode).not.toBe(0);
  expect(elsewhere.stderr).toContain("not in a capture directory");

  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);

test("the dashboard's access key is never read from or written through a link planted at its path", async () => {
  const { root, outside } = await layout();
  await mkdir(join(root, "auth"), { mode: 0o700 });
  const file = join(root, "auth", "dashboard.key");
  const known = join(outside, "known.key");
  await writeFile(known, `${"k".repeat(43)}\n`, { mode: 0o644 });
  await symlink(known, file);
  const before = await snapshot(outside);
  await expect(accessKey(file, root)).rejects.toMatchObject({
    code: "RIG_FILE_UNTRUSTED",
  });
  expect(await snapshot(outside)).toEqual(before);

  await rm(file);
  const previous = process.umask(0o002);
  let key: string;
  try {
    key = await accessKey(file, root);
  } finally {
    process.umask(previous);
  }
  expect(key).toHaveLength(43);
  expect(await mode(file)).toBe(0o600);
  expect(await accessKey(file, root)).toBe(key);
});

test("the diagnostic log is never rotated, archived or chmodded through a link planted at it", async () => {
  const { root, outside } = await layout();
  await mkdir(join(root, "logs", "rigd"), { recursive: true, mode: 0o700 });
  // An outside file holding yesterday's record, so a rotation would archive it.
  const target = join(outside, "old.jsonl");
  await writeFile(
    target,
    `${JSON.stringify({ timestamp: "2026-10-01T00:00:00.000Z", source: "rigd", level: "info", event: "old" })}\n`,
    { mode: 0o644 },
  );
  await symlink(target, join(root, "logs", "rigd", "rigd.jsonl"));
  const before = await snapshot(outside);
  const log = createFileDiagnosticLog({
    root,
    source: "rigd",
    now: () => new Date("2026-10-20T12:00:00.000Z"),
  });
  expect(await log.record({ event: "probe" })).toEqual({
    error: "Diagnostic evidence could not be recorded.",
  });
  expect(await snapshot(outside)).toEqual(before);
  expect(
    (await readdir(join(root, "logs", "rigd"))).filter((name) =>
      name.startsWith("rigd-"),
    ),
  ).toEqual([]);
});

test("Monitor's database is never opened through a link planted at it or at a sidecar, and a new one is private", async () => {
  const { root, outside } = await layout();
  const path = join(root, "monitor", "usage.sqlite");
  await mkdir(join(root, "monitor"), { mode: 0o700 });
  const database = join(outside, "other.sqlite");
  await writeFile(database, "", { mode: 0o644 });
  for (const planted of [path, `${path}-wal`]) {
    await symlink(database, planted);
    const before = await snapshot(outside);
    expect(() => openSqliteUsageHistory(path)).toThrow(
      expect.objectContaining({ code: "RIG_FILE_UNTRUSTED" }),
    );
    expect(await snapshot(outside)).toEqual(before);
    await rm(planted);
  }
  const previous = process.umask(0o002);
  try {
    const history = openSqliteUsageHistory(path);
    await history.close();
  } finally {
    process.umask(previous);
  }
  expect((await lstat(path)).isFile()).toBe(true);
  expect(await mode(path)).toBe(0o600);
});

test("a state update whose directory cannot be flushed says so, with the new state already in place; an env edit takes it as done", async () => {
  const { root } = await layout();
  const store = new FileStateStore(root);
  await store.update(() => {});
  const real = fsp.open;
  const failing = spyOn(fsp, "open").mockImplementation((async (
    ...args: Parameters<typeof real>
  ) => {
    const handle = await real(...args);
    if (args[1] === "r" && (await handle.stat()).isDirectory())
      handle.sync = async () => {
        throw Object.assign(new Error("I/O error"), { code: "EIO" });
      };
    return handle;
  }) as typeof real);
  try {
    await expect(
      store.update((state) => {
        state.activity = [];
        (state as { marker?: string }).marker = "new";
      }),
    ).rejects.toMatchObject({
      code: "FILE_NOT_DURABLE",
      details: { path: join(root, "runtime", "state.json"), published: true },
    });
    expect(
      await readFile(join(root, "runtime", "state.json"), "utf8"),
    ).toContain('"marker": "new"');

    const env = join(root, "env", "demo", "all.env");
    await expect(
      writeEnvFile(
        env,
        {},
        ABSENT_REVISION,
        [{ op: "set", key: "A", value: "1" }],
        join(root, "env"),
      ),
    ).resolves.toMatchObject({ exists: true, keys: ["A"] });
  } finally {
    failing.mockRestore();
  }
});
