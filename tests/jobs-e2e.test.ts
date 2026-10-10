import { expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
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
/** A job that prints, then waits until `release` exists. */
const waiting = (release: string) =>
  `echo "started in $(pwd) data=\${rig.data} api=\${services.api.port}"; while [ ! -f '${release}' ]; do sleep 0.1; done; echo finished`;

test("rig run starts a job now, refuses a second run while it goes, and its run shows in status, logs and activity", async () => {
  const f = await rigFixture();
  try {
    const release = join(f.base, "release");
    await writeFile(join(f.repo, "api.ts"), API_SOURCE);
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: melody
services:
  api:
    command: ${JSON.stringify(API)}
    environment: { PORT: "\${port}" }
    ports: { http: auto }
jobs:
  link-resolver:
    command: ${JSON.stringify(waiting(release))}
    schedule: "17 */6 * * *"
    timezone: America/Chicago
    targets: [working]
  palettes:
    command: echo palettes
    schedule: "43 4 * * *"
targets:
  working: true
`,
    );
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    expect(await f.rig(["up", "working"])).toMatchObject({ code: 0 });
    expect(await f.rig(["run", "link-resolver", "working"])).toMatchObject({
      code: 0,
      stdout: "melody working link-resolver started\n",
    });
    const second = await f.rig(["run", "link-resolver", "working"]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(
      "link-resolver is still running on working",
    );
    expect(await jobStatus(f, "working", "link-resolver")).toMatchObject({
      schedule: "17 */6 * * *",
      timeZone: "America/Chicago",
      state: "running",
      scheduled: true,
      nextRunAt: expect.stringMatching(/:17:00\.000Z$/),
      running: { trigger: "manual" },
    });
    // A job the working Target's plan does not run is named with the line that would add it.
    const other = await f.rig(["run", "palettes", "working"]);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain(
      "jobs.palettes.targets in rig.yaml does not name working",
    );
    await writeFile(release, "");
    const ended = await until(
      () => jobStatus(f, "working", "link-resolver"),
      (job) => job?.state === "idle",
    );
    expect(ended).toMatchObject({
      last: { outcome: "succeeded", exitCode: 0, trigger: "manual" },
    });
    const logs = (
      await f.rig(["logs", "working", "--service", "link-resolver"])
    ).stdout;
    expect(logs).toMatch(
      /link-resolver {2}> started in .*project data=.*\/data\/link-resolver api=\d+/,
    );
    expect(logs).toContain("link-resolver  > finished");
    const activity = (await f.rig(["activity"])).stdout;
    expect(activity).toMatch(/melody {2}working {2}run {2}started/);
    expect(activity).toMatch(/melody {2}working {2}job {2}succeeded/);
    expect(activity).toContain("link-resolver: succeeded in");
    // rig down stops a run in progress within its stop budget, and records it as stopped by Rig.
    await Bun.$`rm -f ${release}`;
    expect(await f.rig(["run", "link-resolver", "working"])).toMatchObject({
      code: 0,
    });
    expect(await f.rig(["down", "working"])).toMatchObject({ code: 0 });
    expect(await jobStatus(f, "working", "link-resolver")).toMatchObject({
      state: "idle",
      scheduled: false,
      last: { outcome: "stopped" },
    });
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 90000);

test("a deploy leaves a running job on the checkout it started in, which is given back once the run ends", async () => {
  const f = await rigFixture();
  try {
    const release = join(f.base, "release");
    await writeFile(join(f.repo, "api.ts"), API_SOURCE);
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: melody
services:
  api:
    command: ${JSON.stringify(API)}
    environment: { PORT: "\${port}" }
    ports: { http: auto }
jobs:
  mb-mirror:
    command: ${JSON.stringify(waiting(release))}
    schedule: "0 7 * * 3,6"
targets:
  stable: true
`,
    );
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    await f.commit();
    expect(await f.rig(["deploy"])).toMatchObject({ code: 0 });
    expect(await f.rig(["run", "mb-mirror"])).toMatchObject({
      code: 0,
      stdout: "melody stable mb-mirror started\n",
    });
    const revisions = async () =>
      (
        await Promise.all(
          (await readdir(join(f.root, "targets"))).map(async (project) =>
            Promise.all(
              (await readdir(join(f.root, "targets", project))).map((target) =>
                readdir(
                  join(f.root, "targets", project, target, "revisions"),
                ).catch(() => []),
              ),
            ),
          ),
        )
      ).flat(2);
    const first = await revisions();
    expect(first.length).toBe(1);
    await writeFile(join(f.repo, "unrelated.txt"), "change\n");
    await f.commit();
    expect(await f.rig(["deploy"])).toMatchObject({ code: 0 });
    // The run goes on, from the first checkout, which the deploy kept.
    expect(await jobStatus(f, "stable", "mb-mirror")).toMatchObject({
      state: "running",
    });
    expect((await revisions()).sort()).toEqual(expect.arrayContaining(first));
    expect((await revisions()).length).toBe(2);
    await writeFile(release, "");
    const ended = await until(
      () => jobStatus(f, "stable", "mb-mirror"),
      (job) => job?.state === "idle",
    );
    expect(ended).toMatchObject({ last: { outcome: "succeeded" } });
    const logs = (await f.rig(["logs", "stable", "--service", "mb-mirror"]))
      .stdout;
    expect(logs).toContain(`/revisions/${first[0]}`);
    const left = await until(revisions, (names) => names.length === 1);
    expect(left).not.toContain(first[0]);
    expect(await f.rig(["down", "stable"])).toMatchObject({ code: 0 });
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 120000);
