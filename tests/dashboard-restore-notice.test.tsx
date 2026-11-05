import { afterAll, expect, mock, test } from "bun:test";
import * as actions from "../web/server/actions";
import type { JobReport } from "../web/lib/types";
import { restoreNotice, type BackupView } from "../web/lib/backups";
import { elements, mountWithoutDom, textOf } from "./support/hook-harness";

/** A backup's row says how a restore of it stands from the job's status, never from a start reply kept in the page. */

const real = { ...actions };
let restoring = false;
mock.module("../web/server/actions", () => ({
  ...real,
  async runRestore(input: unknown) {
    if (!restoring) return real.runRestore(input);
    return {
      ok: true,
      value: {
        operationId: "op-1",
        action: "restore",
        outcome: "started",
        backup: "B1",
      },
    };
  },
}));
afterAll(() => {
  restoring = false;
});
const { RestoreBackupButton } =
  await import("../web/components/restore-backup-button");

const STARTED = "2026-11-05T10:00:00.000Z";
const FINISHED = "2026-11-05T10:00:01.000Z";
const restoreRun = (
  backup: string,
  outcome?: NonNullable<JobReport["last"]>["outcome"],
) =>
  ({
    trigger: "restore" as const,
    restore: backup,
    startedAt: STARTED,
    ...(outcome ? { outcome, finishedAt: FINISHED, durationMs: 1000 } : {}),
    summary: "summary",
  }) as NonNullable<JobReport["last"]>;

test("a row says restoring while its restore runs, then how it ended; a restore of another backup is not its own", () => {
  expect(restoreNotice({ running: restoreRun("B1") }, "B1")?.word).toBe(
    "restoring",
  );
  expect(restoreNotice({ running: restoreRun("B2") }, "B1")).toBeUndefined();
  expect(restoreNotice({ last: restoreRun("B1", "succeeded") }, "B1")).toEqual({
    word: "restored",
    failed: false,
  });
  expect(restoreNotice({ last: restoreRun("B1", "failed") }, "B1")).toEqual({
    word: "restore failed",
    failed: true,
  });
  expect(
    restoreNotice({ last: restoreRun("B2", "failed") }, "B1"),
  ).toBeUndefined();
});

test("a later run of the job does not speak for the restore before it", () => {
  const later = {
    trigger: "manual",
    backup: "B9",
    startedAt: FINISHED,
    finishedAt: FINISHED,
    outcome: "failed",
    summary: "summary",
  } as NonNullable<JobReport["last"]>;
  expect(restoreNotice({ last: later }, "B1")).toBeUndefined();
});

const backup: BackupView = {
  target: "stable",
  job: "books",
  id: "B1",
  path: "/rig/backups/B1",
  run: "run-1",
  trigger: "manual",
  startedAt: STARTED,
  finishedAt: FINISHED,
};
const job = (fields: Partial<JobReport>) =>
  ({
    name: "books",
    schedule: "0 3 * * *",
    timeZone: "UTC",
    state: "idle",
    scheduled: true,
    backup: { keep: 3, restore: true, count: 1, bytes: 0 },
    ...fields,
  }) as JobReport;

test("the row follows the job after the restore's start was answered: a finished run never still says restoring", async () => {
  restoring = true;
  const mounted = mountWithoutDom(RestoreBackupButton);
  const shown = (fields: Partial<JobReport>) =>
    mounted.render({
      project: "ledger",
      target: { kind: "stable", name: "stable" },
      job: job(fields),
      backup,
    });
  shown({});
  const confirm = elements(mounted.tree).find(
    (each) =>
      textOf(each) === "Restore" && each.props.variant === "destructive",
  )!;
  mounted.act(confirm.props.onClick as () => void);
  // The start was answered, then a refresh brought the run; no timer is involved.
  for (let turn = 0; turn < 20; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
    mounted.render();
  }
  shown({ state: "running", running: restoreRun("B1") });
  expect(textOf(mounted.tree)).toContain("restoring");
  shown({ last: restoreRun("B1", "succeeded") });
  expect(textOf(mounted.tree)).not.toContain("restoring");
  expect(textOf(mounted.tree)).toContain("restored");
  shown({ last: restoreRun("B1", "failed") });
  expect(textOf(mounted.tree)).not.toContain("restoring");
  expect(textOf(mounted.tree)).toContain("restore failed");
  restoring = false;
});

test("a reload, with no start reply in the page, says the same as the page that started it", () => {
  const mounted = mountWithoutDom(RestoreBackupButton);
  mounted.render({
    project: "ledger",
    target: { kind: "stable", name: "stable" },
    job: job({ last: restoreRun("B1", "succeeded") }),
    backup,
  });
  expect(textOf(mounted.tree)).toContain("restored");
});
