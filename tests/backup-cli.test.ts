import { expect, test } from "bun:test";
import type { ProjectStatusReport } from "../src/domain/project-status";
import type { RuntimeCommand } from "../src/daemon/protocol";
import { runRigCli } from "../src/cli/rig";
import { formatBytes } from "../src/domain/bytes";

/** `rig backup list` and `rig backup restore` (ADR 0017) with an injected client: no daemon, filesystem or terminal. */

const BACKUPS = {
  project: "melody",
  backups: [
    {
      target: "stable",
      job: "db-backup",
      id: "20261011T030000Z-17",
      path: "/isolated/.rig/backups/melody/stable/db-backup/20261011T030000Z-17",
      run: "4f1c2b3a-9d8e-4f00-8a1b-2c3d4e5f6a7b",
      trigger: "schedule",
      startedAt: "2026-10-11T03:00:00.000Z",
      finishedAt: "2026-10-11T03:00:41.000Z",
      bytes: 13_400_000,
    },
    {
      target: "stable",
      job: "db-backup",
      id: "20261010T030000Z-16",
      path: "/isolated/.rig/backups/melody/stable/db-backup/20261010T030000Z-16",
      run: "0a1b2c3d-0000-4000-8000-000000000000",
      trigger: "manual",
      startedAt: "2026-10-10T03:00:00.000Z",
      finishedAt: "2026-10-10T03:00:39.000Z",
      bytes: 812,
      missing: true,
    },
  ],
};

function harness(
  options: {
    confirm?: boolean;
    /** The outcome of the restore run's end in Activity; absent, it never ends. */
    ended?: string;
    interactive?: boolean;
  } = {},
) {
  const requests: RuntimeCommand[] = [];
  const questions: string[] = [];
  let out = "";
  let err = "";
  const controller = new AbortController();
  let polls = 0;
  const deps = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(): Promise<ProjectStatusReport> {
        return { project: "melody", targets: [] };
      },
      async command(request: RuntimeCommand) {
        requests.push(request);
        if (request.action === "backups") return BACKUPS;
        if (request.action === "restore")
          return {
            operationId: "op-1",
            project: "melody",
            target: "stable",
            action: "restore",
            outcome: "started",
            job: request.job,
            backup: request.backup,
          };
        if (request.action === "activity") {
          polls++;
          // Ctrl-C after a few polls when the restore never ends.
          if (!options.ended && polls === 3) controller.abort();
          return {
            operations: [
              {
                id: "op-1",
                action: "restore",
                outcome: "started",
                occurredAt: "2026-10-11T09:00:00.000Z",
                message: "db-backup from 20261011T030000Z-17",
              },
              ...(options.ended && polls > 1
                ? [
                    {
                      id: "op-1",
                      action: "restore",
                      outcome: options.ended,
                      occurredAt: "2026-10-11T09:00:05.000Z",
                      message: `db-backup: restore from 20261011T030000Z-17 ${options.ended === "succeeded" ? "succeeded in 5s" : "failed in 5s: exit 1"}`,
                    },
                  ]
                : []),
            ],
          };
        }
        return {};
      },
    },
    output: {
      write(value: string) {
        out += value;
      },
      error(value: string) {
        err += value;
      },
    },
    diagnostics: {
      async record() {
        return { path: "/isolated/.rig/logs/rig/rig.jsonl" };
      },
    },
    ...(options.interactive === false
      ? {}
      : {
          interaction: {
            async text(_message: string, value: string) {
              return value;
            },
            async confirm(message: string) {
              questions.push(message);
              return options.confirm ?? true;
            },
          },
        }),
    signal: controller.signal,
    wait: async () => {},
    newOperationId: () => "op-1",
  };
  return {
    deps,
    requests,
    questions,
    out: () => out,
    err: () => err,
  };
}

test("rig backup list sends the backups read, every Target's unless one is named, and shows time, size and run", async () => {
  const all = harness();
  expect(await runRigCli(["backup", "list"], all.deps)).toBe(0);
  expect(all.requests).toEqual([
    { action: "backups", repoPath: "/workspace", operationId: "op-1" },
  ]);
  expect(all.out()).toContain(
    "stable  db-backup  20261011T030000Z-17  2026-10-11 03:00:41Z  13 MB  schedule  run 4f1c2b3a",
  );
  expect(all.out()).toContain(
    "20261010T030000Z-16  2026-10-10 03:00:39Z  812 B  rig run  run 0a1b2c3d  MISSING",
  );
  expect(all.out()).toContain(
    "In /isolated/.rig/backups/melody/<target>/<job>/<id>",
  );
  const one = harness();
  expect(
    await runRigCli(
      [
        "backup",
        "list",
        "db-backup",
        "preview",
        "--deployment",
        "feat-1a2b3c4d",
      ],
      one.deps,
    ),
  ).toBe(0);
  expect(one.requests[0]).toMatchObject({
    action: "backups",
    job: "db-backup",
    target: "preview",
    deployment: "feat-1a2b3c4d",
  });
  // A Target's name alone lists that Target's backups; a job named like a Target is named with its Target.
  for (const [args, expected] of [
    [["stable"], { target: "stable" }],
    [["preview", "feature/a"], { target: "preview", branch: "feature/a" }],
    [["stable", "stable"], { job: "stable", target: "stable" }],
  ] as const) {
    const h = harness();
    expect(await runRigCli(["backup", "list", ...args], h.deps)).toBe(0);
    expect(h.requests).toEqual([
      expect.objectContaining({ action: "backups", ...expected }),
    ]);
    if (!("job" in expected)) expect(h.requests[0]).not.toHaveProperty("job");
  }
  const json = harness();
  expect(await runRigCli(["backup", "list", "--json"], json.deps)).toBe(0);
  expect(JSON.parse(json.out())).toEqual(BACKUPS);
  for (const path of [["backup"], ["backup", "list"], ["backup", "restore"]])
    for (const flag of ["--help", "-h"]) {
      const h = harness();
      expect(await runRigCli([...path, flag], h.deps)).toBe(0);
      expect(h.out()).toContain(`Usage: rig ${path.join(" ")}`);
      expect(h.requests).toEqual([]);
    }
  const help = harness();
  await runRigCli(["backup", "restore", "--help"], help.deps);
  expect(help.out()).toContain("does not stop the Target's Services");
  expect(help.out()).toContain("--yes");
});

test("rig backup restore resolves latest, asks before it acts, then waits for the run and says how it went", async () => {
  const h = harness({ ended: "succeeded" });
  expect(
    await runRigCli(["backup", "restore", "db-backup", "latest"], h.deps),
  ).toBe(0);
  expect(h.questions).toEqual([
    expect.stringContaining(
      "Restore db-backup on stable from backup 20261011T030000Z-17 (made 2026-10-11T03:00:41.000Z, 13 MB)?",
    ),
  ]);
  expect(h.questions[0]).toContain("Services keep running");
  // What was shown is what is restored: latest is sent as its id.
  expect(h.requests.find((r) => r.action === "restore")).toMatchObject({
    action: "restore",
    target: "stable",
    job: "db-backup",
    backup: "20261011T030000Z-17",
  });
  expect(h.out()).toBe(
    "melody stable db-backup restored from 20261011T030000Z-17 (succeeded in 5s)\n",
  );
  expect(h.err()).toContain("rig logs stable --service db-backup");
});

test("rig backup restore is cancelled when the answer is no, refused without a terminal unless --yes, and fails when the restore fails", async () => {
  const no = harness({ confirm: false });
  expect(
    await runRigCli(["backup", "restore", "db-backup", "latest"], no.deps),
  ).toBe(1);
  expect(no.requests.map((r) => r.action)).toEqual(["backups"]);
  expect(no.err()).toContain("The operation was cancelled.");
  const headless = harness({ interactive: false });
  expect(
    await runRigCli(
      ["backup", "restore", "db-backup", "20261011T030000Z-17"],
      headless.deps,
    ),
  ).toBe(1);
  expect(headless.requests.map((r) => r.action)).toEqual(["backups"]);
  expect(headless.err()).toContain("needs confirmation");
  expect(headless.err()).toContain("--yes");
  const yes = harness({ interactive: false, ended: "succeeded" });
  expect(
    await runRigCli(
      ["backup", "restore", "db-backup", "latest", "working", "--yes"],
      yes.deps,
    ),
  ).toBe(0);
  expect(yes.requests.find((r) => r.action === "restore")).toMatchObject({
    target: "working",
    backup: "20261011T030000Z-17",
  });
  const failed = harness({ ended: "failed" });
  expect(
    await runRigCli(
      ["backup", "restore", "db-backup", "latest", "--yes"],
      failed.deps,
    ),
  ).toBe(1);
  expect(failed.err()).toContain("failed in 5s: exit 1");
  expect(failed.err()).toContain("rig logs stable --service db-backup");
  // A backup the list does not have is never restored unconfirmed: refused before anything is sent.
  const unknown = harness();
  expect(
    await runRigCli(
      ["backup", "restore", "db-backup", "20200101T000000Z-1"],
      unknown.deps,
    ),
  ).toBe(1);
  expect(unknown.requests.map((r) => r.action)).toEqual(["backups"]);
  expect(unknown.err()).toContain("has no backup 20200101T000000Z-1");
  expect(unknown.err()).toContain("20261011T030000Z-17");
  const bad = harness();
  expect(
    await runRigCli(["backup", "restore", "db-backup", "yesterday"], bad.deps),
  ).toBe(1);
  expect(bad.requests).toEqual([]);
  expect(bad.err()).toContain("is not a backup id");
});

test("a Ctrl-C while a restore runs stops the wait, not the restore", async () => {
  const h = harness();
  expect(
    await runRigCli(
      ["backup", "restore", "db-backup", "latest", "--yes"],
      h.deps,
    ),
  ).toBe(130);
  expect(h.err()).toContain("Stopped waiting; the restore goes on");
  expect(h.err()).toContain("rig activity op-1");
});

test("sizes read as Finder shows them", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(999)).toBe("999 B");
  expect(formatBytes(4_200)).toBe("4.2 kB");
  expect(formatBytes(13_400_000)).toBe("13 MB");
  expect(formatBytes(1_600_000_000)).toBe("1.6 GB");
});
