import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAdminActivityJournal } from "../src/adapters/admin-activity";
import { DaemonAdmin } from "../src/daemon/admin";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-admin-activity-"));
  roots.push(root);
  return root;
}
test("admin journal records final outcomes and survives daemon-independent readback", async () => {
  const root = await fixture(),
    now = () => "2026-09-09T10:00:00Z";
  const journal = createAdminActivityJournal({
    root,
    now,
    id: () => "fallback-id",
  });
  expect(await journal.read()).toEqual([]);
  expect(
    await journal.append({
      id: "operation-1",
      action: "daemon-install",
      outcome: "installed",
    }),
  ).toEqual({});
  await journal.append({
    id: "operation-2",
    action: "daemon-uninstall",
    outcome: "failed",
    message: "TARGETS_RUNNING",
  });
  const reopened = createAdminActivityJournal({
    root,
    now,
    id: () => "unused",
  });
  expect(await reopened.read()).toMatchObject([
    { id: "operation-1", action: "daemon-install", outcome: "installed" },
    {
      id: "operation-2",
      action: "daemon-uninstall",
      outcome: "failed",
      message: "TARGETS_RUNNING",
    },
  ]);
});
test("corrupt admin history rejects read and returns warning on append without altering bytes", async () => {
  const root = await fixture(),
    journal = createAdminActivityJournal({
      root,
      now: () => "2026-09-09T10:00:00Z",
      id: () => "id",
    });
  await journal.append({ action: "daemon-install", outcome: "installed" });
  const path = join(root, "runtime", "admin-activity.jsonl");
  await writeFile(path, '{"outcome":"installed"}\n');
  await expect(journal.read()).rejects.toThrow("invalid");
  expect(
    (
      await journal.append({
        action: "daemon-uninstall",
        outcome: "uninstalled",
      })
    ).warning,
  ).toBeTruthy();
  expect(await readFile(path, "utf8")).toBe('{"outcome":"installed"}\n');
});
test("daemon administration records final no-op and failed outcomes with the supplied correlation identity", async () => {
  const root = await fixture(),
    admin = new DaemonAdmin({
      root,
      command: [],
      mode: "process",
      userHome: root,
    });
  expect(await admin.uninstall("noop-id")).toMatchObject({
    outcome: "unchanged",
  });
  await expect(admin.install("failure-id")).rejects.toThrow(
    "No daemon executable",
  );
  const entries = await createAdminActivityJournal({
    root,
    now: () => "",
    id: () => "",
  }).read();
  expect(entries).toMatchObject([
    { id: "noop-id", action: "daemon-uninstall", outcome: "unchanged" },
    {
      id: "failure-id",
      action: "daemon-install",
      outcome: "failed",
      message: "DAEMON_COMMAND",
    },
  ]);
});
test("activity write failure warns without changing a verified no-op administration result", async () => {
  const root = await fixture(),
    admin = new DaemonAdmin({
      root,
      command: [],
      mode: "process",
      userHome: root,
      activity: {
        async read() {
          return [];
        },
        async append() {
          return { warning: "Evidence is unavailable." };
        },
      },
    });
  expect(await admin.uninstall()).toEqual({
    installed: false,
    running: false,
    reachable: false,
    outcome: "unchanged",
    warnings: ["Evidence is unavailable."],
  });
});
test("verified daemon installation and shutdown persist activity after the daemon is gone", async () => {
  const root = await fixture(),
    script = join(root, "daemon.ts");
  await writeFile(
    script,
    `import {runDaemonHost} from ${JSON.stringify(join(import.meta.dir, "../src/daemon/host.ts"))};await runDaemonHost({root:process.env.RIG_ROOT!,port:0,handle:async()=>({ready:true}),shutdown:async()=>{}})`,
  );
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, script],
    mode: "process",
    userHome: root,
  });
  try {
    expect(await admin.install("install-proof")).toMatchObject({
      outcome: "installed",
      reachable: true,
    });
    expect(await admin.uninstall("uninstall-proof")).toMatchObject({
      outcome: "uninstalled",
      running: false,
    });
    expect(
      await createAdminActivityJournal({
        root,
        now: () => "",
        id: () => "",
      }).read(),
    ).toMatchObject([
      { id: "install-proof", outcome: "installed" },
      { id: "uninstall-proof", outcome: "uninstalled" },
    ]);
  } finally {
    await admin.uninstall().catch(() => {});
  }
}, 15000);
