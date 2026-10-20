import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BackupList } from "../web/components/backup-list";
import {
  backupsOf,
  restoreBlocked,
  restoreCommand,
  restoreConfirmed,
  type BackupView,
} from "../web/lib/backups";
import { jobTile } from "../web/lib/matrix";
import { commandSchema } from "../src/daemon/protocol";
import type { JobReport } from "../web/lib/types";

/** The Jobs tab's backups (ADR 0017): which backups a card lists, when Restore is offered, what it sends, and the list. */

const backup = (fields: Partial<BackupView>): BackupView => ({
  target: "stable",
  job: "db-backup",
  id: "20261011T030000Z-17",
  path: "/rig/backups/melody/stable/db-backup/20261011T030000Z-17",
  run: "run-1",
  trigger: "schedule",
  startedAt: "2026-10-11T03:00:00.000Z",
  finishedAt: "2026-10-11T03:00:41.000Z",
  bytes: 13_400_000,
  ...fields,
});
const job = (fields: Partial<JobReport> = {}): JobReport => ({
  name: "db-backup",
  schedule: "0 3 * * *",
  timeZone: "UTC",
  state: "idle",
  scheduled: true,
  backup: { keep: 14, restore: true, count: 2, bytes: 13_400_812 },
  ...fields,
});

test("a card lists its own job's backups in its own Target, newest first as the backups read orders them", () => {
  // The newer one finished at an earlier time (a clock set back between them): the list's order stands, not the times.
  const older = backup({
    id: "20261011T030000Z-16",
    finishedAt: "2026-10-11T03:00:39.000Z",
  });
  const newer = backup({
    id: "20261011T020000Z-17",
    finishedAt: "2026-10-11T02:00:41.000Z",
  });
  const all = [
    newer,
    older,
    backup({ target: "working", id: "20261011T040000Z-3" }),
    backup({ job: "files-backup", id: "20261011T050000Z-1" }),
  ];
  expect(backupsOf(all, { name: "stable" }, "db-backup")).toEqual([
    newer,
    older,
  ]);
});

test("Restore is offered only for a job with a restore command, while nothing of it runs, for a backup that is there", () => {
  expect(restoreBlocked(job(), backup({}))).toBeUndefined();
  expect(
    restoreBlocked(
      job({ backup: { keep: 3, restore: false, count: 1, bytes: 0 } }),
      backup({}),
    ),
  ).toContain("no restore command");
  expect(restoreBlocked(job({ state: "running" }), backup({}))).toContain(
    "never overlaps",
  );
  expect(restoreBlocked(job(), backup({ missing: true }))).toContain("gone");
  expect(restoreBlocked(job({ removed: true }), backup({}))).toContain(
    "no longer in rig.yaml",
  );
});

test("the typed confirmation is the job's name exactly, and the restore sends rig backup restore's command", () => {
  expect(restoreConfirmed("db-backup", "db-backup")).toBe(true);
  expect(restoreConfirmed(" db-backup ", "db-backup")).toBe(true);
  expect(restoreConfirmed("db-backu", "db-backup")).toBe(false);
  expect(restoreConfirmed("DB-BACKUP", "db-backup")).toBe(false);
  expect(restoreConfirmed("", "db-backup")).toBe(false);
  const command = restoreCommand(
    "melody",
    { kind: "preview", name: "feat-1a2b3c4d" },
    "db-backup",
    "20261011T030000Z-17",
  );
  expect(command).toEqual({
    action: "restore",
    project: "melody",
    target: "preview",
    deployment: "feat-1a2b3c4d",
    job: "db-backup",
    backup: "20261011T030000Z-17",
  });
  expect(commandSchema.safeParse(command).success).toBe(true);
});

test("a restore in progress reads as restoring on the job's tile", () => {
  expect(
    jobTile(
      job({
        state: "running",
        running: {
          trigger: "restore",
          restore: "20261011T030000Z-17",
          startedAt: "2026-10-11T09:00:00.000Z",
          summary: "running",
        },
      }),
      Date.parse("2026-10-11T09:00:05.000Z"),
    ),
  ).toMatchObject({ word: "restoring", health: "orange", busy: true });
});

test("the backup list shows each backup's time, size and origin with its control, and says when there are none", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  const html = renderToStaticMarkup(
    <BackupList
      summary={job().backup!}
      backups={[
        backup({}),
        backup({
          id: "20261010T030000Z-16",
          trigger: "manual",
          finishedAt: "2026-10-10T03:00:39.000Z",
          bytes: 812,
          missing: true,
        }),
      ]}
      now={now}
      action={(each) => <button type="button">Restore {each.id}</button>}
    />,
  );
  expect(html).toContain("2 of 14 kept, 13 MB");
  expect(html).toContain("13 MB");
  expect(html).toContain("812 B");
  expect(html).toContain("scheduled");
  expect(html).toContain("rig run");
  expect(html).toContain("9 h ago");
  expect(html).toContain("directory deleted");
  expect(html).toContain('title="Run run-1"');
  expect(html).toContain("Restore 20261011T030000Z-17");
  expect(html).toContain("Restore 20261010T030000Z-16");
  // The newest first, as given.
  expect(html.indexOf("20261011T030000Z-17")).toBeLessThan(
    html.indexOf("20261010T030000Z-16"),
  );
  const empty = renderToStaticMarkup(
    <BackupList
      summary={{ keep: 3, restore: false, count: 0, bytes: 0 }}
      backups={[]}
      now={now}
    />,
  );
  expect(empty).toContain("0 of 3 kept");
  expect(empty).toContain("no restore command");
  expect(empty).toContain("No backups yet.");
});
