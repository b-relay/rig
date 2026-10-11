import { afterEach, expect, test } from "bun:test";
import { mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBackupStorage } from "../src/adapters/backup-storage";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type { BackupRecord, RuntimeState } from "../src/domain/runtime";
import type {
  ProcessObservation,
  Supervisor,
  ManagedProcess,
} from "../src/providers/contracts";
import {
  allocateBackup,
  backupId,
  expiredBackups,
} from "../src/runtime/backups";
import type { BackupStorage } from "../src/runtime/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { runtimeWorld } from "./support/runtime-world";
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
  });
  expect(await readdir(run.backup!.path)).toEqual([]);
  expect(await mode(run.backup!.path)).toBe(0o700);
  const start = f.starts.at(-1)!;
  expect(start.env.RIG_BACKUP_DIR).toBe(run.backup!.path);
  expect(start.command).toEqual([
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
      "failed in 2s: exit 1 (rig run); its backup directory was deleted",
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
  // Pure: the backup that just finished stays even when its time sorts older (a clock set back).
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
  expect(expiredBackups([fresh, newer, newest], 2, "a")).toEqual([newer]);
  expect(expiredBackups([fresh, newer, newest], 1, "a")).toEqual([
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
  expect(start.command).toEqual([
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
      outcome: "started",
      message: "db-backup from 20261011T030001Z-1",
    }),
    expect.objectContaining({
      action: "restore",
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
