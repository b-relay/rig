import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createBackupStorage } from "../src/adapters/backup-storage";
import { parseProjectConfig } from "../src/config";
import type { PlanJob, ProjectConfig } from "../src/config/types";
import type {
  BackupRecord,
  RuntimeState,
  StateStore,
  TargetRecord,
} from "../src/domain/runtime";
import type {
  ProcessObservation,
  Supervisor,
  ManagedProcess,
} from "../src/providers/contracts";
import {
  allocateBackup,
  backupId,
  expiredBackups,
  jobBackups,
  selectBackup,
} from "../src/runtime/backups";
import {
  BACKUP_DIR_VARIABLE,
  settleJobRun,
  startJobRun,
  type JobRunDependencies,
} from "../src/runtime/jobs";
import type { BackupStorage } from "../src/runtime/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { runtimeWorld } from "./support/runtime-world";
import { writtenCommand } from "../src/config/plan-defaults";
import { localActivation } from "./support/activation-doubles";
import { STATE_VERSION } from "../src/runtime/state-schema";
import { revisionStanding } from "../src/runtime/revisions";

/** Backups (ADR 0017) through the real runtime and the real backup storage under a temporary RIG_ROOT, over a scripted
 * supervisor: what each run gets, what a run's end keeps or deletes, and what a restore runs. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(options: { keep?: number; failRemovals?: number } = {}) {
  const config: ProjectConfig = parseProjectConfig({
    name: "melody",
    services: { db: { command: "serve-db", ports: { pg: 5544 } } },
    jobs: {
      "db-backup": {
        command: 'dump -p ${services.db.port} -f "$RIG_BACKUP_DIR/melody.dump"',
        schedule: "0 3 * * *",
        timezone: "UTC",
        working_dir: "ops",
        environment: { PGUSER: "melody" },
        backup: {
          keep: options.keep ?? 2,
          restore:
            'restore -p ${services.db.port} "$RIG_BACKUP_DIR/melody.dump"',
        },
      },
      // A backup job without a restore command.
      "files-backup": {
        command: "tar -cf $RIG_BACKUP_DIR/files.tar .",
        schedule: "0 4 * * *",
        backup: { keep: 3 },
      },
      plain: { command: "echo plain", schedule: "0 5 * * *" },
    },
    // Previews are on so a test can record the working Target as one and destroy it.
    targets: { working: true, preview: true },
  });
  const processes = new Map<string, ProcessObservation>();
  const starts: ManagedProcess[] = [];
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      starts.push(request);
      processes.set(request.key, {
        state: "running",
        pid: 4000 + starts.length,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key);
      processes.set(key, {
        state: "stopped",
        ...(running?.incarnation ? { incarnation: running.incarnation } : {}),
        signal: "SIGTERM",
      });
      return {
        outcome: running?.state === "running" ? "stopped" : "unchanged",
      };
    },
    async shutdown() {},
    async detach() {},
  };
  let failRemovals = options.failRemovals ?? 0;
  let storage!: BackupStorage;
  /** Stands in for making a run's directory when set: given the path and the real `create`. */
  const hooks: {
    create?: (path: string, create: BackupStorage["create"]) => Promise<void>;
  } = {};
  const world = await runtimeWorld({
    name: "backups",
    config,
    activation: localActivation([5544]),
    supervisor: () => supervisor,
    startsAt: "2026-10-11T03:00:00.000Z",
    readinessDeadlineMs: 2000,
    dependencies: ({ root }) => {
      const real = createBackupStorage(root);
      storage = {
        ...real,
        async create(path) {
          if (hooks.create) return await hooks.create(path, real.create);
          return await real.create(path);
        },
        async remove(path) {
          if (failRemovals > 0) {
            failRemovals--;
            throw new Error("disk busy");
          }
          return await real.remove(path);
        },
      };
      return {
        backups: storage,
        files: {
          async selectPorts(input: {
            requests: { name: string; preferred?: number }[];
          }) {
            return Object.fromEntries(
              input.requests.map((r) => [r.name, r.preferred!]),
            );
          },
          async inspectPreviewDeletion() {},
          async destroyPreview() {},
        } as unknown as RuntimeDependencies["files"],
      };
    },
  });
  roots.push(world.root);
  const runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  await runtime.command({
    action: "up",
    repoPath: world.repo,
    target: "working",
  });
  const target = (await world.store.read()).targets[0]!;
  const keyOf = (job: string) => `${target.id}:job:${job}`;
  let runs = 0;
  const run = (job = "db-backup", operationId = `r${++runs}`) =>
    runtime.command({
      action: "run",
      repoPath: world.repo,
      target: "working",
      job,
      operationId,
    }) as Promise<{ outcome: string; operationId: string }>;
  const running = async (job = "db-backup") =>
    (await world.store.read()).jobs?.find((r) => r.job === job)?.running;
  /** Ends the run in progress of `job` with `exitCode` and settles it as the scheduler would. */
  const finish = async (exitCode: number, job = "db-backup") => {
    const current = (await running(job))!;
    processes.set(keyOf(job), {
      state: "stopped",
      exitCode,
      incarnation: current.id,
    });
    world.clock.ms += 2000;
    await runtime.settleJob({
      targetId: target.id,
      job,
      runId: current.id,
    });
  };
  const backups = async (job = "db-backup") =>
    ((await world.store.read()).backups ?? []).filter((b) => b.job === job);
  return {
    world,
    runtime,
    target,
    starts,
    processes,
    run,
    running,
    finish,
    backups,
    hooks,
    storage: () => storage,
    /** A whole successful backup: a run that writes a file and exits 0, one second later than the last. */
    async backUp(content = "dump") {
      world.clock.ms += 1000;
      await run();
      const path = (await running())!.backup!.path;
      await writeFile(join(path, "melody.dump"), content);
      await finish(0);
      return path;
    },
    restore: (backup: string, operationId?: string) =>
      runtime.command({
        action: "restore",
        repoPath: world.repo,
        target: "working",
        job: "db-backup",
        backup,
        ...(operationId ? { operationId } : {}),
      }) as Promise<{ outcome: string; backup: string }>,
  };
}
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const mode = async (path: string) => (await stat(path)).mode & 0o777;

test("each run of a backup job gets a fresh, empty 0700 directory as $RIG_BACKUP_DIR, named for its UTC start", async () => {
  const f = await fixture();
  await f.run();
  const run = (await f.running())!;
  expect(run.backup).toEqual({
    id: "20261011T030000Z-1",
    path: join(
      f.world.root,
      "backups/melody/working/db-backup/20261011T030000Z-1",
    ),
    keep: 2,
    sequence: 1,
    // Recorded once the directory was made, before the command started.
    made: true,
  });
  expect(await readdir(run.backup!.path)).toEqual([]);
  expect(await mode(run.backup!.path)).toBe(0o700);
  const start = f.starts.at(-1)!;
  expect(start.env.RIG_BACKUP_DIR).toBe(run.backup!.path);
  // The port reaches the command through the variable its environment carries.
  expect([
    ...start.command.slice(0, 2),
    writtenCommand(start.command[2]!, start.env),
  ]).toEqual([
    "/bin/sh",
    "-c",
    'dump -p 5544 -f "$RIG_BACKUP_DIR/melody.dump"',
  ]);
  // A job without backup gets no directory.
  await f.run("plain");
  expect((await f.running("plain"))!.backup).toBeUndefined();
  expect(f.starts.at(-1)!.env.RIG_BACKUP_DIR).toBeUndefined();
  // A second run in the same second gets its own directory.
  await f.finish(1);
  await f.run();
  expect((await f.running())!.backup!.id).toBe("20261011T030002Z-2");
});

test("a successful run is kept and measured, its mode untouched; a failed, timed-out or stopped run leaves nothing", async () => {
  const f = await fixture();
  const kept = await f.backUp("0123456789");
  expect(await f.backups()).toMatchObject([
    { id: "20261011T030001Z-1", path: kept, bytes: 10, trigger: "manual" },
  ]);
  // Nothing changes modes after the directory is made.
  expect(await mode(kept)).toBe(0o700);
  // A failed exit deletes the run's own directory and no backup.
  await f.run();
  const failed = (await f.running())!.backup!.path;
  await writeFile(join(failed, "partial.dump"), "half");
  await f.finish(1);
  expect(await exists(failed)).toBe(false);
  expect((await f.backups()).map((b) => b.path)).toEqual([kept]);
  expect((await f.world.store.read()).backupRemovals).toBeUndefined();
  // So does a run stopped by rig down.
  await f.run();
  const stopped = (await f.running())!.backup!.path;
  await f.runtime.command({
    action: "down",
    repoPath: f.world.repo,
    target: "working",
  });
  expect(await exists(stopped)).toBe(false);
  expect((await f.backups()).map((b) => b.path)).toEqual([kept]);
  const activity = (await f.world.store.read()).activity
    .filter((entry) => entry.action === "job")
    .map((entry) => entry.message);
  expect(activity).toEqual([
    expect.stringContaining(
      "succeeded in 2s (rig run); kept backup 20261011T030001Z-1",
    ),
    expect.stringContaining(
      "failed in 2s: exit 1 (rig run); its backup directory was queued for deletion",
    ),
    expect.stringContaining("stopped by Rig"),
  ]);
});

test("after each success only the newest keep backups stay, never the one that just finished, and a failure deletes none", async () => {
  const f = await fixture({ keep: 2 });
  const first = await f.backUp();
  const second = await f.backUp();
  expect((await f.backups()).map((b) => b.path).sort()).toEqual(
    [first, second].sort(),
  );
  const third = await f.backUp();
  expect((await f.backups()).map((b) => b.path).sort()).toEqual(
    [second, third].sort(),
  );
  expect(await exists(first)).toBe(false);
  // The job directory holds exactly the kept ones.
  expect(
    (await readdir(join(f.world.root, "backups/melody/working/db-backup")))
      .length,
  ).toBe(2);
  // A failed run deletes no backup.
  await f.run();
  await f.finish(2);
  expect((await f.backups()).map((b) => b.path).sort()).toEqual(
    [second, third].sort(),
  );
  // Pure: the backup that just finished stays wherever it is in the list given newest first.
  const backup = (id: string, finishedAt: string): BackupRecord => ({
    target: "t",
    project: "p",
    job: "j",
    id,
    path: `/r/backups/${id}`,
    run: id,
    trigger: "schedule",
    startedAt: finishedAt,
    finishedAt,
  });
  const fresh = backup("a", "2026-01-01T00:00:00.000Z");
  const newer = backup("b", "2026-06-01T00:00:00.000Z");
  const newest = backup("c", "2026-07-01T00:00:00.000Z");
  expect(expiredBackups([newest, newer, fresh], 2, "a")).toEqual([newer]);
  expect(expiredBackups([newest, newer, fresh], 1, "a")).toEqual([
    newest,
    newer,
  ]);
});

test("a deletion that fails stays queued and is carried out by a later pass", async () => {
  const f = await fixture({ keep: 1, failRemovals: 1 });
  const first = await f.backUp();
  await f.backUp();
  // The expired backup left the inventory in the run's write, and waits to be deleted.
  expect((await f.world.store.read()).backupRemovals).toEqual([
    expect.objectContaining({ path: first }),
  ]);
  expect(await exists(first)).toBe(true);
  await f.runtime.tidyBackups();
  expect(await exists(first)).toBe(false);
  expect((await f.world.store.read()).backupRemovals).toBeUndefined();
});

test("a restore runs the job's restore command once in the job's environment, with the chosen backup as $RIG_BACKUP_DIR", async () => {
  const f = await fixture();
  const older = await f.backUp("old");
  const newer = await f.backUp("new");
  const backupRun = f.starts.at(-1)!;
  const reply = await f.restore("20261011T030001Z-1", "restore-1");
  expect(reply).toMatchObject({
    outcome: "started",
    backup: "20261011T030001Z-1",
  });
  const start = f.starts.at(-1)!;
  // The port reaches the command through the variable its environment carries.
  expect([
    ...start.command.slice(0, 2),
    writtenCommand(start.command[2]!, start.env),
  ]).toEqual([
    "/bin/sh",
    "-c",
    'restore -p 5544 "$RIG_BACKUP_DIR/melody.dump"',
  ]);
  expect(start.env.RIG_BACKUP_DIR).toBe(older);
  expect(start.env.PGUSER).toBe("melody");
  expect(start.cwd).toBe(backupRun.cwd);
  expect(start.key).toBe(backupRun.key);
  expect(start.incarnation).toBe("restore-1");
  const run = (await f.running())!;
  expect(run).toMatchObject({
    trigger: "restore",
    restore: { id: "20261011T030001Z-1", path: older },
  });
  expect(run.backup).toBeUndefined();
  // While it goes, neither a run of the job nor another restore starts.
  await expect(f.run()).rejects.toMatchObject({
    code: "JOB_RUNNING",
    message: expect.stringContaining("A restore of db-backup is still running"),
  });
  await expect(f.restore("latest")).rejects.toMatchObject({
    code: "JOB_RUNNING",
  });
  await f.finish(0);
  // It made no backup and deleted none.
  expect((await f.backups()).map((b) => b.path).sort()).toEqual(
    [older, newer].sort(),
  );
  const entries = (await f.world.store.read()).activity.filter(
    (entry) => entry.id === "restore-1",
  );
  expect(entries).toEqual([
    expect.objectContaining({
      action: "restore",
      component: { kind: "job", name: "db-backup" },
      outcome: "started",
      message: "db-backup from 20261011T030001Z-1",
    }),
    expect.objectContaining({
      action: "restore",
      component: { kind: "job", name: "db-backup" },
      outcome: "succeeded",
      message: expect.stringContaining(
        "db-backup: restore from 20261011T030001Z-1 succeeded in 2s",
      ),
    }),
  ]);
  // latest is the newest.
  await f.restore("latest");
  expect((await f.running())!.restore!.path).toBe(newer);
});

test("a restore is refused while a backup runs, for a job without restore, for an unknown or deleted backup, and for a job that keeps none", async () => {
  const f = await fixture();
  const kept = await f.backUp();
  await f.run();
  await expect(f.restore("latest")).rejects.toMatchObject({
    code: "JOB_RUNNING",
    message: expect.stringContaining("db-backup is still running"),
  });
  await f.finish(0);
  await expect(f.restore("20200101T000000Z-99")).rejects.toMatchObject({
    code: "BACKUP_UNKNOWN",
    hint: expect.stringContaining("20261011T030001Z-1"),
  });
  const restore = (job: string) =>
    f.runtime.command({
      action: "restore",
      repoPath: f.world.repo,
      target: "working",
      job,
      backup: "latest",
    });
  await expect(restore("files-backup")).rejects.toMatchObject({
    code: "BACKUP_NO_RESTORE",
    hint: expect.stringContaining("jobs.files-backup.backup.restore"),
  });
  await expect(restore("plain")).rejects.toMatchObject({
    code: "BACKUP_NOT_CONFIGURED",
  });
  // A backup whose directory was deleted by hand is refused, and shown missing.
  await f.storage().remove(kept);
  await expect(f.restore("20261011T030001Z-1")).rejects.toMatchObject({
    code: "BACKUP_MISSING",
  });
  const listed = (await f.runtime.command({
    action: "backups",
    repoPath: f.world.repo,
  })) as { backups: { id: string; missing?: true }[] };
  expect(
    listed.backups.find((b) => b.id === "20261011T030001Z-1"),
  ).toMatchObject({ missing: true });
});

test("the backups read lists every Target's backups newest first, narrowed by job and Target, and status sums them", async () => {
  const f = await fixture({ keep: 5 });
  await f.backUp("aaaa");
  await f.backUp("bbbbbb");
  const listed = (await f.runtime.command({
    action: "backups",
    repoPath: f.world.repo,
  })) as { project: string; backups: Record<string, unknown>[] };
  expect(listed.project).toBe("melody");
  expect(listed.backups).toEqual([
    expect.objectContaining({
      target: "working",
      job: "db-backup",
      id: "20261011T030004Z-2",
      bytes: 6,
      trigger: "manual",
    }),
    expect.objectContaining({ id: "20261011T030001Z-1", bytes: 4 }),
  ]);
  const narrowed = (await f.runtime.command({
    action: "backups",
    repoPath: f.world.repo,
    job: "files-backup",
  })) as { backups: unknown[] };
  expect(narrowed.backups).toEqual([]);
  const stable = (await f.runtime.command({
    action: "backups",
    repoPath: f.world.repo,
    target: "stable",
  })) as { backups: unknown[] };
  expect(stable.backups).toEqual([]);
  const status = await f.runtime.status({
    repoPath: f.world.repo,
    target: "working",
  });
  const jobs = status.targets[0]!.jobs!;
  expect(jobs.find((job) => job.name === "db-backup")!.backup).toEqual({
    keep: 5,
    restore: true,
    count: 2,
    bytes: 10,
    latest: {
      id: "20261011T030004Z-2",
      finishedAt: expect.any(String),
      bytes: 6,
    },
  });
  expect(jobs.find((job) => job.name === "files-backup")!.backup).toMatchObject(
    { restore: false, count: 0, bytes: 0 },
  );
  expect(jobs.find((job) => job.name === "plain")!.backup).toBeUndefined();
});

test("destroying a Preview deletes its backups; another Target's stay", async () => {
  const f = await fixture();
  const kept = await f.backUp();
  // Another Target's backup, recorded as the working Target's neighbour.
  const elsewhere = join(f.world.root, "backups/melody/stable/db-backup/x");
  await f.storage().create(elsewhere);
  await f.world.store.update((state) => {
    state.backups!.push({
      ...state.backups![0]!,
      target: "another",
      id: "20261011T020000Z-x",
      path: elsewhere,
    });
  });
  await f.world.store.update((state) => {
    const recorded = state.targets.find((t) => t.id === f.target.id)!;
    recorded.kind = "preview";
    recorded.name = "feat-1a2b3c4d";
    recorded.plan.target = "preview";
    recorded.plan.deploymentName = "feat-1a2b3c4d";
  });
  await f.world.open().command({
    action: "destroy",
    repoPath: f.world.repo,
    target: "preview",
    deployment: "feat-1a2b3c4d",
  });
  expect(await exists(kept)).toBe(false);
  expect(await exists(elsewhere)).toBe(true);
  expect((await f.world.store.read()).backups?.map((b) => b.path)).toEqual([
    elsewhere,
  ]);
});

test("backup storage refuses any path outside RIG_ROOT/backups and never follows a symlink inside a backup when it deletes", async () => {
  const f = await fixture();
  const storage = f.storage();
  await expect(storage.remove(f.world.repo)).rejects.toMatchObject({
    code: "BACKUP_PATH",
  });
  await expect(
    storage.create(join(f.world.root, "backups", "..", "elsewhere")),
  ).rejects.toMatchObject({ code: "BACKUP_PATH" });
  const outsideFile = join(f.world.root, "precious.txt");
  await writeFile(outsideFile, "keep me");
  const outsideDirectory = join(f.world.root, "precious");
  await mkdir(outsideDirectory);
  await writeFile(join(outsideDirectory, "inside.txt"), "keep me too");
  // A run that left symlinks to a file and to directories outside: deleting the backup removes the links only.
  await f.run();
  const path = (await f.running())!.backup!.path;
  await symlink(outsideFile, join(path, "file-link"));
  await symlink(outsideDirectory, join(path, "directory-link"));
  await mkdir(join(path, "nested"));
  await symlink(outsideDirectory, join(path, "nested", "deeper-link"));
  await f.finish(0);
  expect(await storage.remove(path)).toBe("removed");
  expect(await exists(path)).toBe(false);
  expect(await Bun.file(outsideFile).text()).toBe("keep me");
  expect(await Bun.file(join(outsideDirectory, "inside.txt")).text()).toBe(
    "keep me too",
  );
  // Empty parents go with the last backup, up to the backup root itself.
  expect(await exists(join(f.world.root, "backups/melody"))).toBe(false);
  expect(await exists(join(f.world.root, "backups"))).toBe(true);
});

test("a symlinked directory between the backup root and a backup is never created through, read through, or deleted through", async () => {
  const f = await fixture();
  const storage = f.storage();
  const kept = await f.backUp();
  // The job's directory is pointed outside the root, at a directory holding an entry of the same name.
  const outside = join(f.world.root, "outside");
  const jobDirectory = join(f.world.root, "backups/melody/working/db-backup");
  await mkdir(join(outside, "20261011T030001Z-1"), { recursive: true });
  await writeFile(join(outside, "20261011T030001Z-1", "data"), "not Rig's");
  await rm(jobDirectory, { recursive: true });
  await symlink(outside, jobDirectory);
  const untouched = async () => {
    expect(await readdir(outside)).toEqual(["20261011T030001Z-1"]);
    expect(
      await Bun.file(join(outside, "20261011T030001Z-1", "data")).text(),
    ).toBe("not Rig's");
  };
  expect(await storage.exists(kept)).toBe(false);
  expect(await storage.measure(kept)).toBeUndefined();
  expect(await storage.remove(kept)).toBe("skipped");
  await untouched();
  await expect(
    storage.create(join(jobDirectory, "20261011T040000Z-x")),
  ).rejects.toMatchObject({ code: "BACKUP_PATH" });
  await untouched();
  // A run of the job fails to start rather than write through the symlink, and the list shows the backup missing.
  f.world.clock.ms += 1000;
  await expect(f.run()).rejects.toMatchObject({ code: "BACKUP_PATH" });
  await untouched();
  const listed = (await f.runtime.command({
    action: "backups",
    repoPath: f.world.repo,
  })) as { backups: { missing?: true }[] };
  expect(listed.backups).toEqual([expect.objectContaining({ missing: true })]);
  // Queued for deletion, it is forgotten without anything outside being deleted.
  await f.world.store.update((state) => {
    state.backups = [];
    state.backupRemovals = [
      { target: f.target.id, project: state.projects[0]!.id, path: kept },
    ];
  });
  await f.runtime.tidyBackups();
  expect((await f.world.store.read()).backupRemovals).toBeUndefined();
  await untouched();
});

test("a FIFO in a backup is measured and deleted without being opened", async () => {
  const f = await fixture({ keep: 1 });
  await f.run();
  const first = (await f.running())!.backup!.path;
  await Bun.$`mkfifo ${join(first, "pipe")}`;
  await writeFile(join(first, "dump"), "12345");
  await f.finish(0);
  expect((await f.backups())[0]!.bytes).toBeGreaterThanOrEqual(5);
  // The next backup evicts it; deleting it never opens the FIFO either.
  await f.backUp();
  expect(await exists(first)).toBe(false);
});

test("a run that exits 0 but removed its directory keeps no backup and evicts none", async () => {
  const f = await fixture({ keep: 1 });
  const kept = await f.backUp();
  await f.run();
  const run = (await f.running())!;
  await rm(run.backup!.path, { recursive: true });
  await f.finish(0);
  expect((await f.backups()).map((b) => b.path)).toEqual([kept]);
  const state = await f.world.store.read();
  expect(state.jobs!.find((r) => r.job === "db-backup")!.last).toMatchObject({
    outcome: "succeeded",
    backup: { lost: true },
  });
  expect(state.activity.at(-1)!.message).toContain(
    "it left no backup directory, so none was kept",
  );
});

test("a backup id is never reused, so an evicted backup's id never names another backup", async () => {
  const f = await fixture({ keep: 1 });
  const key = `${f.target.id}:job:db-backup`;
  // Three successful runs within one UTC second, each evicting the one before, with run ids that start alike.
  const made: { id: string; path: string }[] = [];
  for (const [content, operationId] of [
    ["first", "backup-001"],
    ["second", "backup-002"],
    ["third", "backup-003"],
  ] as const) {
    await f.run("db-backup", operationId);
    const run = (await f.running())!;
    await writeFile(join(run.backup!.path, "melody.dump"), content);
    f.processes.set(key, {
      state: "stopped",
      exitCode: 0,
      incarnation: run.id,
    });
    await f.runtime.settleJob({
      targetId: f.target.id,
      job: "db-backup",
      runId: run.id,
    });
    made.push(run.backup!);
  }
  expect(made.map((backup) => backup.id)).toEqual([
    "20261011T030000Z-1",
    "20261011T030000Z-2",
    "20261011T030000Z-3",
  ]);
  expect(new Set(made.map((backup) => backup.path)).size).toBe(3);
  expect((await f.backups()).map((backup) => backup.id)).toEqual([
    "20261011T030000Z-3",
  ]);
  // The first run's id names nothing now: refused, never matched to the third run's backup.
  const starts = f.starts.length;
  await expect(f.restore("20261011T030000Z-1")).rejects.toMatchObject({
    code: "BACKUP_UNKNOWN",
  });
  expect(f.starts.length).toBe(starts);
  await f.restore("20261011T030000Z-3");
  expect(f.starts.at(-1)!.env.RIG_BACKUP_DIR).toBe(made[2]!.path);
});

test("backup numbers only grow per backup directory: not reset by deletion, a Preview made again, a Project registered again, or a rename", () => {
  expect(backupId("2026-10-11T03:00:00.987Z", 17)).toBe("20261011T030000Z-17");
  const storage = {
    location: (
      scope: { project: string; target: string; job: string },
      id: string,
    ) => `/rig/backups/${scope.project}/${scope.target}/${scope.job}/${id}`,
  };
  const state = {
    version: STATE_VERSION,
    projects: [{ id: "p1", name: "melody" }],
    targets: [],
    activity: [],
  } as unknown as RuntimeState;
  const at = "2026-10-11T03:00:00.000Z";
  const allocate = (
    target: string,
    project: string,
    name = "feat-x",
    job = "db-backup",
  ) =>
    allocateBackup(
      state,
      { id: target, projectId: project, name },
      job,
      at,
      storage,
    );
  /** Records the backup a run allocated as kept, as a successful end would. */
  const keep = (
    target: string,
    project: string,
    made: { id: string; path: string },
  ) =>
    (state.backups ??= []).push({
      target,
      project,
      job: "db-backup",
      ...made,
      run: made.id,
      trigger: "manual",
      startedAt: at,
      finishedAt: at,
    });
  expect(allocate("t1", "p1")).toEqual({
    id: "20261011T030000Z-1",
    path: "/rig/backups/melody/feat-x/db-backup/20261011T030000Z-1",
    sequence: 1,
  });
  keep("t1", "p1", allocate("t1", "p1"));
  expect(state.backups!.map((b) => b.id)).toEqual(["20261011T030000Z-2"]);
  // Destroyed (its backups go) and made again under the same name: the sequence continues.
  state.backups = [];
  expect(allocate("t2", "p1").id).toBe("20261011T030000Z-3");
  // Forgotten and registered again under the same name, with new ids: it continues still.
  state.projects = [{ id: "p2", name: "melody" }] as RuntimeState["projects"];
  const kept = allocate("t3", "p2");
  expect(kept.id).toBe("20261011T030000Z-4");
  keep("t3", "p2", kept);
  // Renamed while it has backups: the new directory's sequence starts past the numbers its kept backups carry.
  state.projects = [{ id: "p2", name: "tune" }] as RuntimeState["projects"];
  expect(allocate("t3", "p2")).toEqual({
    id: "20261011T030000Z-5",
    path: "/rig/backups/tune/feat-x/db-backup/20261011T030000Z-5",
    sequence: 5,
  });
  // Another Target or job has a sequence of its own.
  expect(allocate("t4", "p2", "stable").id).toBe("20261011T030000Z-1");
  expect(allocate("t3", "p2", "feat-x", "files-backup").id).toBe(
    "20261011T030000Z-1",
  );
});

test("a backup number survives a Preview destroy, so a Preview made again under the same name never reissues an id", async () => {
  const f = await fixture({ keep: 1 });
  await f.world.store.update((state) => {
    const recorded = state.targets.find((t) => t.id === f.target.id)!;
    recorded.kind = "preview";
    recorded.name = "feat-1a2b3c4d";
    recorded.plan.target = "preview";
    recorded.plan.deploymentName = "feat-1a2b3c4d";
  });
  // A backup of the Preview, made and settled as rig run preview --deployment feat-1a2b3c4d would.
  await f.runtime.command({
    action: "run",
    repoPath: f.world.repo,
    target: "preview",
    deployment: "feat-1a2b3c4d",
    job: "db-backup",
    operationId: "preview-run",
  });
  const run = (await f.running())!;
  expect(run.backup!.id).toBe("20261011T030000Z-1");
  await f.finish(0);
  expect((await f.backups()).map((b) => b.id)).toEqual(["20261011T030000Z-1"]);
  const destroyed = (await f.world.store.read()).backupSequences;
  expect(destroyed).toEqual([
    { project: "melody", target: "feat-1a2b3c4d", job: "db-backup", last: 1 },
  ]);
  await f.world.open().command({
    action: "destroy",
    repoPath: f.world.repo,
    target: "preview",
    deployment: "feat-1a2b3c4d",
  });
  // The destroy forgot the Preview and its backups, but not the numbers it issued.
  expect((await f.world.store.read()).backups).toEqual([]);
  expect((await f.world.store.read()).backupSequences).toEqual(destroyed);
});

test("a backup a stopped rigd left without a size is measured by the next tidy", async () => {
  const f = await fixture();
  await f.backUp("abc");
  // As a rigd that stopped between recording the end and measuring would leave it.
  await f.world.store.update((state) => {
    delete state.backups![0]!.bytes;
  });
  await f.runtime.tidyBackups();
  expect((await f.backups())[0]!.bytes).toBe(3);
});

test("a restore settles the run that ended before it chooses, so retention never deletes the backup it chose", async () => {
  const f = await fixture({ keep: 1 });
  const older = await f.backUp("old");
  // The next run has exited, but nothing has recorded its end yet.
  f.world.clock.ms += 1000;
  await f.run();
  const pending = (await f.running())!;
  f.processes.set(`${f.target.id}:job:db-backup`, {
    state: "stopped",
    exitCode: 0,
    incarnation: pending.id,
  });
  const starts = f.starts.length;
  // Restoring the older backup by its id: settling that run keeps its backup, and keep: 1 lets the older one go.
  await expect(f.restore("20261011T030001Z-1")).rejects.toMatchObject({
    code: "BACKUP_EXPIRED",
  });
  expect(f.starts.length).toBe(starts);
  expect(await exists(older)).toBe(false);
  expect((await f.backups()).map((b) => b.path)).toEqual([
    pending.backup!.path,
  ]);
  // latest now means the backup that run kept, which the restore reads, still there.
  await f.restore("latest");
  expect((await f.running())!.restore!.path).toBe(pending.backup!.path);
  expect(await exists(pending.backup!.path)).toBe(true);
});

test("forgetting a Project keeps its backups on disk, drops their records, and says where they are", async () => {
  const f = await fixture();
  const path = await f.backUp();
  await f.runtime.command({
    action: "down",
    repoPath: f.world.repo,
    target: "working",
  });
  const reply = (await f.runtime.command({
    action: "forget",
    repoPath: f.world.repo,
    project: "melody",
  })) as { warnings?: string[] };
  expect(await exists(path)).toBe(true);
  expect((await f.world.store.read()).backups).toEqual([]);
  expect(reply.warnings).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        `Its backups in ${join(f.world.root, "backups/melody")} were kept on disk`,
      ),
    ]),
  );
});

test("a backup run holds the checkout it started in while it runs, and its end records it among the held checkouts (ADR 0016)", async () => {
  const f = await fixture();
  await f.run();
  // A deploy moved the Target to another checkout while the backup ran in this one.
  const started = (await f.running())!.workspace!;
  await f.world.store.update((state) => {
    const saved = state.targets.find((t) => t.id === f.target.id)!;
    saved.plan = { ...saved.plan, workspacePath: join(f.world.root, "next") };
  });
  const standing = async () =>
    await revisionStanding(started, await f.world.store.read(), f.world.deps);
  expect(await standing()).toBe("held");
  // Every write from here on, to see the one that records the run's end.
  const store = f.world.deps.store;
  const update = store.update.bind(store);
  const writes: RuntimeState[] = [];
  store.update = async (change) => {
    await update(change);
    writes.push(await store.read());
  };
  await f.finish(0);
  expect(await f.backups()).toHaveLength(1);
  // The write that kept the backup also held the checkout the run started in.
  const ending = writes.find((state) =>
    state.backups?.some((backup) => backup.run === "r1"),
  )!;
  expect(ending.heldCheckouts).toEqual([
    { target: f.target.id, project: f.target.projectId, workspace: started },
  ]);
  // db, started from the same checkout, still runs there, so it stays held; once db is gone nothing runs in it, and the
  // next sweep forgets it (the working Target owns no revision to remove; a deployed Target's would be given back).
  expect(await standing()).toBe("held");
  f.processes.set(`${f.target.id}:db`, { state: "stopped" });
  expect(await standing()).toBe("free");
  await f.runtime.releaseHeldCheckouts(f.target.id);
  expect((await store.read()).heldCheckouts ?? []).toEqual([]);
});

/** Starts a run of db-backup under a rigd of its own and abandons it while its directory is being made, as a rigd that
 * dies there: `before` it is made, or `after` making it (or failing to, when something is already there) but before
 * anything else is recorded. Resolves the run as recorded then. */
async function abandonedRun(
  f: Awaited<ReturnType<typeof fixture>>,
  stage: "before" | "after",
) {
  let reached!: () => void;
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  f.hooks.create = async (path, create) => {
    if (stage === "after") await create(path).catch(() => {});
    reached();
    // The rigd is gone: nothing after this ever runs.
    await new Promise(() => {});
  };
  void f.world
    .open()
    .command({
      action: "run",
      repoPath: f.world.repo,
      target: "working",
      job: "db-backup",
    })
    .catch(() => {});
  await stopped;
  delete f.hooks.create;
  return (await f.running())!;
}
/** What the next rigd does with the abandoned run `run`: its scheduler finds no process and settles the run, then tidies. */
async function recoverRun(
  f: Awaited<ReturnType<typeof fixture>>,
  run: { id: string },
) {
  const next = f.world.open();
  await next.settleJob({
    targetId: f.target.id,
    job: "db-backup",
    runId: run.id,
  });
  await next.tidyBackups();
  const state = await f.world.store.read();
  return {
    last: state.jobs!.find((r) => r.job === "db-backup")!.last!,
    removals: state.backupRemovals ?? [],
    message: state.activity.at(-1)!.message,
  };
}

test("a rigd that stops while a run makes its backup directory never deletes a directory the run did not make", async () => {
  const f = await fixture();
  const jobDirectory = join(f.world.root, "backups/melody/working/db-backup");
  /** An operator's copy at the path the next run is given. */
  const planted = async (sequence: number) => {
    const at = new Date(f.world.clock.ms).toISOString();
    const path = join(jobDirectory, backupId(at, sequence));
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "operator-copy"), "precious");
    return path;
  };

  // Stopped after the run was recorded, before its directory was made: what is at its path is someone else's.
  const first = await planted(1);
  const before = await abandonedRun(f, "before");
  expect(before.backup!.path).toBe(first);
  let recovered = await recoverRun(f, before);
  expect(await Bun.file(join(first, "operator-copy")).text()).toBe("precious");
  expect(recovered.removals).toEqual([]);
  expect(recovered.last.outcome).toBe("unknown");
  expect(recovered.message).toContain(
    "its backup directory was left in place, as Rig cannot tell that this run made it",
  );

  // Stopped after making it failed (EEXIST), before that failure was recorded.
  f.world.clock.ms += 1000;
  const second = await planted(2);
  const refused = await abandonedRun(f, "after");
  expect(refused.backup!.path).toBe(second);
  recovered = await recoverRun(f, refused);
  expect(await Bun.file(join(second, "operator-copy")).text()).toBe("precious");
  expect(recovered.removals).toEqual([]);

  // Stopped right after making it, before recording that: Rig cannot show the run made it, so it stays (empty).
  f.world.clock.ms += 1000;
  const made = await abandonedRun(f, "after");
  expect(await readdir(made.backup!.path)).toEqual([]);
  recovered = await recoverRun(f, made);
  expect(await exists(made.backup!.path)).toBe(true);
  expect(recovered.removals).toEqual([]);

  // A run recorded as having made its directory, whose end nothing recorded (the Mac restarted): its directory goes.
  f.world.clock.ms += 1000;
  await f.world.open().command({
    action: "run",
    repoPath: f.world.repo,
    target: "working",
    job: "db-backup",
  });
  const owned = (await f.running())!;
  expect(owned.backup!.made).toBe(true);
  await writeFile(join(owned.backup!.path, "melody.dump"), "half");
  f.processes.set(`${f.target.id}:job:db-backup`, { state: "stopped" });
  recovered = await recoverRun(f, owned);
  expect(recovered.last.outcome).toBe("unknown");
  expect(await exists(owned.backup!.path)).toBe(false);
  expect(recovered.removals).toEqual([]);
  expect(recovered.message).toContain(
    "its backup directory was queued for deletion",
  );
  // Nothing was kept as a backup along the way, and the directories Rig cannot show it made are all still there.
  expect(await f.backups()).toEqual([]);
  expect((await readdir(jobDirectory)).sort()).toEqual(
    [first, second, made.backup!.path].map((p) => basename(p)).sort(),
  );
});

test("a run whose directory was already there fails to start, leaves it alone, and says so", async () => {
  const f = await fixture();
  const path = join(
    f.world.root,
    "backups/melody/working/db-backup",
    backupId(new Date(f.world.clock.ms).toISOString(), 1),
  );
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "operator-copy"), "precious");
  await expect(f.run()).rejects.toMatchObject({ code: "BACKUP_DIRECTORY" });
  expect(await Bun.file(join(path, "operator-copy")).text()).toBe("precious");
  const state = await f.world.store.read();
  expect(state.backupRemovals).toBeUndefined();
  const last = state.jobs!.find((r) => r.job === "db-backup")!.last!;
  expect(last.outcome).toBe("start-failed");
  const status = await f.runtime.status({
    repoPath: f.world.repo,
    target: "working",
  });
  expect(
    status.targets[0]!.jobs!.find((job) => job.name === "db-backup")!.last!
      .summary,
  ).toContain("its backup directory was left in place");
});

test("latest and retention follow the order backups were made in, not the clock, across a clock set back and a rigd restart", async () => {
  const f = await fixture({ keep: 2 });
  const first = await f.backUp("first");
  // The clock is corrected an hour back: the next backups carry earlier times than the first.
  f.world.clock.ms -= 3_600_000;
  const second = await f.backUp("second");
  await f.restore("latest");
  expect((await f.running())!.restore!.path).toBe(second);
  await f.finish(0);
  const third = await f.backUp("third");
  // keep: 2 keeps the two made last, whatever their times say.
  expect((await f.backups()).map((b) => b.path).sort()).toEqual(
    [second, third].sort(),
  );
  expect(await exists(first)).toBe(false);
  expect(await exists(second)).toBe(true);
  // The clock goes forward past the first again; a new rigd over the same state still knows which is newest.
  f.world.clock.ms += 7_200_000;
  const next = f.world.open();
  const listed = (await next.command({
    action: "backups",
    repoPath: f.world.repo,
  })) as { backups: { path: string }[] };
  expect(listed.backups.map((b) => b.path)).toEqual([third, second]);
  const status = await next.status({
    repoPath: f.world.repo,
    target: "working",
  });
  expect(
    status.targets[0]!.jobs!.find((job) => job.name === "db-backup")!.backup!
      .latest!.id,
  ).toBe(third.split("/").at(-1)!);
  await next.command({
    action: "restore",
    repoPath: f.world.repo,
    target: "working",
    job: "db-backup",
    backup: "latest",
  });
  expect((await f.running())!.restore!.path).toBe(third);
});

test("backups are ordered by sequence, and those an older Rig recorded by their place in the inventory, one total order whatever their ids or times say", () => {
  const backup = (id: string, at: string, sequence?: number): BackupRecord => ({
    target: "t1",
    project: "p1",
    job: "dump",
    id,
    path: `/r/backups/demo/working/dump/${id}`,
    run: id,
    trigger: "manual",
    startedAt: at,
    finishedAt: at,
    ...(sequence !== undefined ? { sequence } : {}),
  });
  // Recorded by older Rigs, in this order: the first writer's second backup of one second (`-2`), then a later unsuffixed
  // one, then one of the writer before this, whose time a clock set back made the earliest.
  const legacySuffixed = backup(
    "20261012T030000Z-2",
    "2026-10-12T03:00:00.000Z",
  );
  const legacyPlain = backup("20261013T030000Z", "2026-10-13T03:00:00.000Z");
  const legacySkewed = backup("20261011T030000Z-3", "2026-10-11T03:00:00.000Z");
  // Recorded by this Rig, the second with its clock set back.
  const fresh = backup("20261014T030000Z-4", "2026-10-14T03:00:00.000Z", 4);
  const fresher = backup("20261013T120000Z-5", "2026-10-13T12:00:00.000Z", 5);
  const state = { backups: [legacySuffixed, legacyPlain] };
  const target = { id: "t1", name: "working" };
  expect(selectBackup(state, target, "dump", "latest")).toBe(legacyPlain);
  state.backups.push(legacySkewed);
  expect(selectBackup(state, target, "dump", "latest")).toBe(legacySkewed);
  state.backups.push(fresh, fresher);
  expect(jobBackups(state, "t1", "dump")).toEqual([
    fresher,
    fresh,
    legacySkewed,
    legacyPlain,
    legacySuffixed,
  ]);
  expect(selectBackup(state, target, "dump", "latest")).toBe(fresher);
  expect(
    expiredBackups(jobBackups(state, "t1", "dump"), 3, fresher.id),
  ).toEqual([legacyPlain, legacySuffixed]);
});

test("after an upgrade, latest and retention take the backups an older Rig recorded in the order it recorded them", async () => {
  const f = await fixture({ keep: 2 });
  // As the first writer left them: a second backup of one second, then a later one without a number.
  const legacy = [
    { id: "20261010T030000Z-2", at: "2026-10-10T03:00:00.000Z" },
    { id: "20261011T020000Z", at: "2026-10-11T02:00:00.000Z" },
  ];
  const paths: string[] = [];
  for (const { id } of legacy) {
    const path = f
      .storage()
      .location({ project: "melody", target: "working", job: "db-backup" }, id);
    await f.storage().create(path);
    paths.push(path);
  }
  const [older, newer] = paths as [string, string];
  await f.world.store.update((state) => {
    state.backups = legacy.map(({ id, at }, i) => ({
      target: f.target.id,
      project: f.target.projectId,
      job: "db-backup",
      id,
      path: paths[i]!,
      run: `legacy-${i}`,
      trigger: "schedule",
      startedAt: at,
      finishedAt: at,
      bytes: 0,
    }));
  });
  await f.restore("latest");
  expect((await f.running())!.restore!.path).toBe(newer);
  await f.finish(0);
  // The first backup this Rig makes continues past the numbers kept, and keep: 2 lets the oldest legacy one go.
  const made = await f.backUp();
  expect((await f.backups()).find((b) => b.path === made)).toMatchObject({
    id: "20261011T030003Z-3",
    sequence: 3,
  });
  expect((await f.backups()).map((b) => b.path).sort()).toEqual(
    [newer, made].sort(),
  );
  expect(await exists(older)).toBe(false);
  expect(await exists(newer)).toBe(true);
  await f.restore("latest");
  expect((await f.running())!.restore!.path).toBe(made);
});

test("a backup directory that cannot be deleted stays queued, and its run says it was queued for deletion, not deleted", async () => {
  const f = await fixture({ failRemovals: 1 });
  await f.run();
  const path = (await f.running())!.backup!.path;
  await writeFile(join(path, "partial.dump"), "half");
  await f.finish(1);
  expect(await exists(path)).toBe(true);
  expect((await f.world.store.read()).backupRemovals).toEqual([
    expect.objectContaining({ path }),
  ]);
  const status = await f.runtime.status({
    repoPath: f.world.repo,
    target: "working",
  });
  const said = [
    (await f.world.store.read()).activity.at(-1)!.message,
    status.targets[0]!.jobs!.find((job) => job.name === "db-backup")!.last!
      .summary,
  ];
  for (const text of said) {
    expect(text).toContain("its backup directory was queued for deletion");
    expect(text).not.toContain("was deleted");
  }
  await f.runtime.tidyBackups();
  expect(await exists(path)).toBe(false);
});

test("a backup an earlier Rig sealed read-only is deleted when it expires, without changing anything it links to", async () => {
  const f = await fixture({ keep: 1 });
  const sealed = await f.backUp("old");
  // Outside the backup: a file hard-linked into it, and a directory a symlink in it points at, each with its own mode.
  const linkedFile = join(f.world.root, "linked.txt");
  await writeFile(linkedFile, "shared");
  await chmod(linkedFile, 0o444);
  const outside = join(f.world.root, "outside");
  await mkdir(outside, { mode: 0o500 });
  await mkdir(join(sealed, "nested", "deeper"), { recursive: true });
  await writeFile(join(sealed, "nested", "deeper", "data"), "nested");
  await link(linkedFile, join(sealed, "nested", "hard-link"));
  await symlink(outside, join(sealed, "nested", "outside-link"));
  // As the sealing writer left a backup: files without write bits, directories 0500, children first.
  await chmod(join(sealed, "nested", "deeper", "data"), 0o444);
  await chmod(join(sealed, "melody.dump"), 0o444);
  for (const directory of ["nested/deeper", "nested", "."])
    await chmod(join(sealed, directory), 0o500);
  try {
    await f.backUp("new");
    expect(await exists(sealed)).toBe(false);
    expect((await f.world.store.read()).backupRemovals).toBeUndefined();
    expect(await Bun.file(linkedFile).text()).toBe("shared");
    expect(await mode(linkedFile)).toBe(0o444);
    expect(await mode(outside)).toBe(0o500);
  } finally {
    // So the temporary root can be removed whatever happened.
    await Bun.$`chmod -R u+w ${f.world.root}`.nothrow().quiet();
  }
});

test("Projects whose names differ only in case never get the same backup directory, even starting in the same second", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-backup-case-"));
  roots.push(root);
  const job: PlanJob = {
    name: "dump",
    command: 'echo data > "$RIG_BACKUP_DIR/data"',
    env: {},
    schedule: "0 0 1 1 *",
    backup: { keep: 1 },
  };
  const target = (id: string, projectId: string) =>
    ({
      id,
      projectId,
      name: "working",
      kind: "working",
      plan: { workspacePath: join(root, id), jobs: [job] },
    }) as unknown as TargetRecord;
  const targets = [target("t1", "p1"), target("t2", "p2")];
  let state = {
    version: STATE_VERSION,
    projects: [
      { id: "p1", name: "auditcase" },
      { id: "p2", name: "AUDITCASE" },
    ],
    targets,
    activity: [],
  } as unknown as RuntimeState;
  // Writes one at a time, each to the state the one before left, as the state file's are.
  let writes: Promise<void> = Promise.resolve();
  const store: StateStore = {
    async read() {
      return structuredClone(state);
    },
    update(change) {
      const next = writes.then(async () => {
        const draft = structuredClone(state);
        await change(draft);
        state = draft;
      });
      writes = next.catch(() => {});
      return next;
    },
  };
  /** The directory each run was handed, by run id. */
  const given = new Map<string, string>();
  const deps: JobRunDependencies = {
    store,
    backups: createBackupStorage(root),
    // Both start in the same second.
    now: () => "2026-10-13T19:54:12.000Z",
    lifecycle: {
      async startJob(_target, _job, incarnation, env) {
        const directory = env![BACKUP_DIR_VARIABLE]!;
        given.set(incarnation, directory);
        await writeFile(join(directory, "data"), incarnation);
        return { outcome: "started" } as never;
      },
      async observeJob(t) {
        const incarnation = t.id === "t1" ? "run-1" : "run-2";
        return { state: "stopped", exitCode: 0, incarnation } as never;
      },
      async stopJob() {
        return undefined as never;
      },
    },
  };
  const runs = await Promise.all(
    targets.map((t, i) =>
      startJobRun(t, job, { id: `run-${i + 1}`, trigger: "schedule" }, deps),
    ),
  );
  expect(runs.map((run) => run.backup!.id)).toEqual([
    "20261013T195412Z-1",
    "20261013T195412Z-2",
  ]);
  for (const [i, t] of targets.entries())
    expect(await settleJobRun(t, "dump", `run-${i + 1}`, deps)).toBe("settled");
  // Each Project keeps its own backup, holding what its own run wrote.
  for (const [i, t] of targets.entries()) {
    const kept = jobBackups(state, t.id, "dump");
    expect(kept.map((b) => b.path)).toEqual([given.get(`run-${i + 1}`)!]);
    expect(await Bun.file(join(kept[0]!.path, "data")).text()).toBe(
      `run-${i + 1}`,
    );
  }
  expect(state.backupSequences).toEqual([
    { project: "auditcase", target: "working", job: "dump", last: 2 },
  ]);
});

test.skipIf(process.platform !== "darwin")(
  "a backup with a volume mounted inside it is not deleted, and nothing on the volume is touched, until it is unmounted",
  async () => {
    const f = await fixture({ keep: 1 });
    const image = join(f.world.root, "volume.dmg");
    await Bun.$`hdiutil create -size 4m -fs HFS+ -volname rig-backup-test -o ${image} -quiet`.quiet();
    const mounted: string[] = [];
    /** Mounts the image at `at`, holding a writable file and a directory sealed 0500, each with its own contents. */
    const mount = async (at: string) => {
      await mkdir(at, { recursive: true });
      await Bun.$`hdiutil attach -nobrowse -noautoopen -mountpoint ${at} ${image} -quiet`.quiet();
      mounted.push(at);
      await mkdir(join(at, "locked"), { recursive: true });
      await writeFile(join(at, "top.txt"), "volume");
      await writeFile(join(at, "locked", "data"), "locked");
      await chmod(join(at, "locked"), 0o500);
    };
    const untouched = async (at: string) => {
      expect(await Bun.file(join(at, "top.txt")).text()).toBe("volume");
      expect(await Bun.file(join(at, "locked", "data")).text()).toBe("locked");
      expect(await mode(join(at, "locked"))).toBe(0o500);
    };
    const detach = async (at: string) => {
      await Bun.$`hdiutil detach ${at} -force -quiet`.quiet();
      mounted.splice(mounted.indexOf(at), 1);
    };
    try {
      // Mounted right inside a backup: refused before anything is deleted.
      const first = await f.backUp("first");
      const atFirst = join(first, "mounted");
      await mount(atFirst);
      await expect(f.storage().remove(first)).rejects.toMatchObject({
        code: "BACKUP_REMOVE",
        details: { path: atFirst, mounted: true },
      });
      await untouched(atFirst);
      // Retention queues it, and it stays queued.
      const second = await f.backUp("second");
      expect((await f.world.store.read()).backupRemovals).toEqual([
        expect.objectContaining({ path: first }),
      ]);
      await f.runtime.tidyBackups();
      await untouched(atFirst);
      expect(await exists(join(first, "melody.dump"))).toBe(true);
      // Unmounted, the next pass deletes the backup.
      await detach(atFirst);
      await f.runtime.tidyBackups();
      expect(await exists(first)).toBe(false);
      expect((await f.world.store.read()).backupRemovals).toBeUndefined();

      // Mounted below a directory the first attempt cannot list: the attempt that opens directories stops at the volume.
      const hidden = join(second, "hidden");
      const atSecond = join(hidden, "mounted");
      await mount(atSecond);
      await chmod(hidden, 0o100);
      await f.backUp("third");
      await f.runtime.tidyBackups();
      await untouched(atSecond);
      expect((await f.world.store.read()).backupRemovals).toEqual([
        expect.objectContaining({ path: second }),
      ]);
      await detach(atSecond);
      await f.runtime.tidyBackups();
      expect(await exists(second)).toBe(false);
    } finally {
      for (const at of mounted)
        await Bun.$`hdiutil detach ${at} -force -quiet`.nothrow().quiet();
      await Bun.$`chmod -R u+rwx ${f.world.root}`.nothrow().quiet();
    }
  },
  60_000,
);
