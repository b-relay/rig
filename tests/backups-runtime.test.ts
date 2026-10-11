import { afterEach, expect, test } from "bun:test";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBackupStorage } from "../src/adapters/backup-storage";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type { BackupRecord } from "../src/domain/runtime";
import type {
  ProcessObservation,
  Supervisor,
  ManagedProcess,
} from "../src/providers/contracts";
import { expiredBackups } from "../src/runtime/backups";
import type { BackupStorage } from "../src/runtime/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { runtimeWorld } from "./support/runtime-world";
import { localActivation } from "./support/activation-doubles";

/** Backups (ADR 0017) through the real runtime and the real backup storage under a temporary RIG_ROOT, over a scripted
 * supervisor: what each run gets, what a run's end keeps or deletes, and what a restore runs. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Kept backups are read-only: their owner opens them before deleting, as Rig does.
    await Bun.$`chmod -R u+w ${root}`.quiet().nothrow();
    await rm(root, { recursive: true, force: true });
  }
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
    targets: { working: true },
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
          await real.remove(path);
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
  const run = (job = "db-backup", operationId?: string) =>
    runtime.command({
      action: "run",
      repoPath: world.repo,
      target: "working",
      job,
      ...(operationId ? { operationId } : {}),
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
    id: "20261011T030000Z",
    path: join(
      f.world.root,
      "backups/melody/working/db-backup/20261011T030000Z",
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
  expect((await f.running())!.backup!.id).toBe("20261011T030002Z");
});

test("a successful run is kept, sealed read-only and measured; a failed, timed-out or stopped run leaves nothing", async () => {
  const f = await fixture();
  const kept = await f.backUp("0123456789");
  expect(await f.backups()).toMatchObject([
    { id: "20261011T030001Z", path: kept, bytes: 10, trigger: "manual" },
  ]);
  expect(await mode(kept)).toBe(0o500);
  expect((await mode(join(kept, "melody.dump"))) & 0o222).toBe(0);
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
      "succeeded in 2s (rig run); kept backup 20261011T030001Z",
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
  await f.runtime.removeBackups();
  expect(await exists(first)).toBe(false);
  expect((await f.world.store.read()).backupRemovals).toBeUndefined();
});

test("a restore runs the job's restore command once in the job's environment, with the chosen backup read-only as $RIG_BACKUP_DIR", async () => {
  const f = await fixture();
  const older = await f.backUp("old");
  const newer = await f.backUp("new");
  const backupRun = f.starts.at(-1)!;
  // Opened up since it was kept: the restore seals it again before it starts.
  await Bun.$`chmod u+w ${older}`;
  const reply = await f.restore("20261011T030001Z", "restore-1");
  expect(reply).toMatchObject({
    outcome: "started",
    backup: "20261011T030001Z",
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
  expect(await mode(older)).toBe(0o500);
  const run = (await f.running())!;
  expect(run).toMatchObject({
    trigger: "restore",
    restore: { id: "20261011T030001Z", path: older },
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
      message: "db-backup from 20261011T030001Z",
    }),
    expect.objectContaining({
      action: "restore",
      outcome: "succeeded",
      message: expect.stringContaining(
        "db-backup: restore from 20261011T030001Z succeeded in 2s",
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
  await expect(f.restore("20200101T000000Z")).rejects.toMatchObject({
    code: "BACKUP_UNKNOWN",
    hint: expect.stringContaining("20261011T030001Z"),
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
  await expect(f.restore("20261011T030001Z")).rejects.toMatchObject({
    code: "BACKUP_MISSING",
  });
  const listed = (await f.runtime.command({
    action: "backups",
    repoPath: f.world.repo,
  })) as { backups: { id: string; missing?: true }[] };
  expect(listed.backups.find((b) => b.id === "20261011T030001Z")).toMatchObject(
    { missing: true },
  );
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
      id: "20261011T030004Z",
      bytes: 6,
      trigger: "manual",
    }),
    expect.objectContaining({ id: "20261011T030001Z", bytes: 4 }),
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
      id: "20261011T030004Z",
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
      id: "20261011T020000Z",
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

test("backup storage refuses any path outside RIG_ROOT/backups and never follows a symlink when it seals or deletes", async () => {
  const f = await fixture();
  const storage = f.storage();
  await expect(storage.remove(f.world.repo)).rejects.toMatchObject({
    code: "BACKUP_PATH",
  });
  await expect(
    storage.create(join(f.world.root, "backups", "..", "elsewhere")),
  ).rejects.toMatchObject({ code: "BACKUP_PATH" });
  const outside = join(f.world.root, "precious.txt");
  await writeFile(outside, "keep me");
  const path = await f.backUp();
  // A run that left a symlink to a file outside: sealing and deleting the backup leave the file alone.
  await Bun.$`chmod u+w ${path} && ln -s ${outside} ${join(path, "link")}`;
  await storage.seal(path);
  expect((await stat(outside)).mode & 0o200).toBe(0o200);
  await storage.remove(path);
  expect(await exists(path)).toBe(false);
  expect(await Bun.file(outside).text()).toBe("keep me");
  // Empty parents go with the last backup, up to the backup root itself.
  expect(await exists(join(f.world.root, "backups/melody"))).toBe(false);
  expect(await exists(join(f.world.root, "backups"))).toBe(true);
});
