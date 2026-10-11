import { expect, test } from "bun:test";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

type Fixture = Awaited<ReturnType<typeof rigFixture>>;
/** The job report of `job` in `target` as rig status --json shows it. */
async function jobStatus(f: Fixture, target: string, job: string) {
  const status = JSON.parse((await f.rig(["status", "--json"])).stdout);
  return status.targets
    .find((t: { name: string }) => t.name === target)
    ?.jobs?.find((j: { name: string }) => j.name === job);
}
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 15000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(150);
    value = await read();
  }
  return value;
}
/** A Service that answers on its one port, so a start passes its start gate. */
const API_SOURCE = `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("ok") });\n`;
const API = `exec '${process.execPath}' api.ts`;

test("a backup job keeps its newest successful backups under RIG_ROOT, drops failed runs, and restores one through rigd", async () => {
  const f = await rigFixture();
  try {
    const fail = join(f.base, "fail");
    const restored = join(f.base, "restored.txt");
    await writeFile(join(f.repo, "api.ts"), API_SOURCE);
    // The dump names its own backup, and the API port shows the job's references resolve.
    const dump = `[ -f '${fail}' ] && exit 3; echo "$(basename "$RIG_BACKUP_DIR") api=\${services.api.port}" > "$RIG_BACKUP_DIR/db.dump"`;
    // The restore copies the dump out, and names the backup it read.
    const restore = `cp "$RIG_BACKUP_DIR/db.dump" '${restored}'; echo "read $(basename "$RIG_BACKUP_DIR")"`;
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: melody
services:
  api:
    command: ${JSON.stringify(API)}
    environment: { PORT: "\${port}" }
    ports: { http: auto }
jobs:
  db-backup:
    command: ${JSON.stringify(dump)}
    schedule: "0 3 * * *"
    timezone: UTC
    targets: [working]
    backup:
      keep: 2
      restore: ${JSON.stringify(restore)}
targets:
  working: true
`,
    );
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    expect(await f.rig(["up", "working"])).toMatchObject({ code: 0 });
    const jobDir = join(f.root, "backups", "melody", "working", "db-backup");
    const backUp = async () => {
      expect(await f.rig(["run", "db-backup", "working"])).toMatchObject({
        code: 0,
        stdout: "melody working db-backup started\n",
      });
      return await until(
        () => jobStatus(f, "working", "db-backup"),
        (job) => job?.state === "idle",
      );
    };
    // Three successful runs: the newest two stay, on disk and in the list.
    for (let n = 0; n < 3; n++)
      expect(await backUp()).toMatchObject({
        last: { outcome: "succeeded" },
      });
    const kept = (await readdir(jobDir)).sort();
    expect(kept).toHaveLength(2);
    expect(kept.every((id) => /^\d{8}T\d{6}Z-[a-z0-9]{8}$/.test(id))).toBe(
      true,
    );
    const listed = JSON.parse(
      (await f.rig(["backup", "list", "db-backup", "working", "--json"]))
        .stdout,
    );
    expect(listed.backups.map((b: { id: string }) => b.id).sort()).toEqual(
      kept,
    );
    expect(listed.backups[0]).toMatchObject({
      target: "working",
      job: "db-backup",
      trigger: "manual",
      bytes: expect.any(Number),
    });
    // A failed run leaves no directory and deletes no backup.
    await writeFile(fail, "");
    expect(await backUp()).toMatchObject({
      last: { outcome: "failed", exitCode: 3 },
      backup: { keep: 2, count: 2, restore: true },
    });
    expect((await readdir(jobDir)).sort()).toEqual(kept);
    await rm(fail);
    const human = await f.rig(["backup", "list"]);
    expect(human.stdout).toContain(`working  db-backup  ${kept[1]}`);
    expect((await f.rig(["status"])).stdout).toContain("backups 2 of 2 kept");
    // A restore without a terminal needs --yes; with it, it runs the restore command against the newest backup and waits.
    const refused = await f.rig([
      "backup",
      "restore",
      "db-backup",
      "latest",
      "working",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--yes");
    const restoredRun = await f.rig([
      "backup",
      "restore",
      "db-backup",
      "latest",
      "working",
      "--yes",
    ]);
    expect(restoredRun).toMatchObject({ code: 0 });
    expect(restoredRun.stdout).toContain(
      `melody working db-backup restored from ${kept[1]}`,
    );
    expect(await Bun.file(restored).text()).toMatch(
      new RegExp(`^${kept[1]} api=\\d+\\n$`),
    );
    const logs = (await f.rig(["logs", "working", "--service", "db-backup"]))
      .stdout;
    expect(logs).toContain(`read ${kept[1]}`);
    const activity = (await f.rig(["activity"])).stdout;
    expect(activity).toMatch(/melody {2}working {2}restore {2}started/);
    expect(activity).toMatch(/melody {2}working {2}restore {2}succeeded/);
    // An unknown backup is refused, naming the ones there are.
    const unknown = await f.rig([
      "backup",
      "restore",
      "db-backup",
      "20200101T000000Z-gone",
      "working",
      "--yes",
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain(kept[1]);
    // Backups survive the Target going down and up.
    expect(await f.rig(["down", "working"])).toMatchObject({ code: 0 });
    expect(await f.rig(["up", "working"])).toMatchObject({ code: 0 });
    expect((await readdir(jobDir)).sort()).toEqual(kept);
    expect(await f.rig(["down", "working"])).toMatchObject({ code: 0 });
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 120000);
