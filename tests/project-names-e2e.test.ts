import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

// #407, #590, #466: a rename left the operator env files, the Tool owners and the deployed history under the old name.
// #628, #593, #689, #399: names that differ only in case, reserved names and overlong names were accepted.

type Fixture = Awaited<ReturnType<typeof rigFixture>>;
const recorded = async (f: Fixture) =>
  JSON.parse(await readFile(join(f.root, "runtime", "state.json"), "utf8"));
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
/** A Git repository at `path` on main with `files`, committed; returns its git. */
async function repository(
  f: Fixture,
  path: string,
  files: Record<string, string>,
) {
  await mkdir(path, { recursive: true });
  const git = async (args: string[]) => {
    const result = await f.run(["git", "-C", path, ...args]);
    if (result.code) throw new Error(`git ${args[0]}: ${result.stderr}`);
  };
  await git(["init", "-b", "main"]);
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(path, name), text);
    if (name.endsWith(".sh")) await chmod(join(path, name), 0o755);
  }
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Rig Test",
    "-c",
    "user.email=rig-test@example.test",
    "commit",
    "-m",
    "fixture",
  ]);
  return git;
}
/** Project `before`, with an operator env file and a Tool, run in its working Target and deployed to stable, then stopped
 * and renamed `after`. Its build writes $MARKER to marker.txt. */
async function renamedProject(f: Fixture) {
  await repository(f, f.repo, {
    "rig.yaml": `name: before
targets: { working: true, stable: true }
build: 'printf "%s" "$MARKER" > marker.txt'
tools:
  cli:
    bin: cli.sh
`,
    "cli.sh": "#!/bin/sh\necho cli\n",
    ".gitignore": "marker.txt\n",
  });
  expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
  expect(await f.rig(["init"])).toMatchObject({ code: 0 });
  const env = join(f.root, "env");
  await mkdir(join(env, "before"), { recursive: true, mode: 0o700 });
  await writeFile(join(env, "before", "all.env"), "MARKER=dummy-marker\n", {
    mode: 0o600,
  });
  expect(await f.rig(["up"])).toMatchObject({ code: 0 });
  expect(await readFile(join(f.repo, "marker.txt"), "utf8")).toBe(
    "dummy-marker",
  );
  expect(await f.rig(["deploy", "stable"])).toMatchObject({ code: 0 });
  expect(await f.rig(["down"])).toMatchObject({ code: 0 });
  expect(await f.rig(["down", "stable"])).toMatchObject({ code: 0 });
  expect(await f.rig(["rename", "after"])).toMatchObject({ code: 0 });
  return env;
}

test("a rename moves the operator env files, and every Target reads them under the new name (#407)", async () => {
  const f = await rigFixture();
  try {
    const env = await renamedProject(f);
    expect(await exists(join(env, "before"))).toBe(false);
    expect(await readFile(join(env, "after", "all.env"), "utf8")).toBe(
      "MARKER=dummy-marker\n",
    );
    expect((await stat(join(env, "after", "all.env"))).mode & 0o777).toBe(
      0o600,
    );
    await writeFile(join(f.repo, "marker.txt"), "");
    expect(await f.rig(["restart", "working"])).toMatchObject({ code: 0 });
    expect(await readFile(join(f.repo, "marker.txt"), "utf8")).toBe(
      "dummy-marker",
    );
    expect(await f.rig(["down"])).toMatchObject({ code: 0 });
    // The deployed plan reads them where they are now.
    const stable = (await recorded(f)).targets.find(
      (t: any) => t.kind === "stable",
    );
    expect(stable.plan.project).toBe("after");
    expect(stable.plan.envFiles.map((file: any) => file.path)).toEqual([
      join(env, "after", "all.env"),
      join(env, "after", "stable.env"),
    ]);
  } finally {
    await f.cleanup();
  }
}, 60000);

test("after a rename, doctor knows a deployed Commit's old name as the Project's own, and that Commit deploys again (#466)", async () => {
  const f = await rigFixture();
  try {
    await renamedProject(f);
    const checks = JSON.parse((await f.rig(["doctor", "--json"])).stdout)
      .checks as any[];
    expect(checks.filter((check) => check.reason === "identity-drift")).toEqual(
      [],
    );
    expect(
      checks.find((check) => check.name === "stable/config"),
    ).toMatchObject({ ok: true });
    expect(checks.find((check) => check.name === "stable/name")).toMatchObject({
      ok: true,
    });
    expect(await f.rig(["deploy", "stable", "--force"])).toMatchObject({
      code: 0,
    });
    expect(await f.rig(["down", "stable"])).toMatchObject({ code: 0 });
    expect((await recorded(f)).projects[0].formerNames).toEqual(["before"]);
  } finally {
    await f.cleanup();
  }
}, 60000);

test("after a rename, a Tool conflict names the owner by its new name (#590)", async () => {
  const f = await rigFixture();
  const other = join(f.base, "other");
  try {
    await renamedProject(f);
    expect(await f.rig(["up", "stable"])).toMatchObject({ code: 0 });
    expect(await f.rig(["down", "stable"])).toMatchObject({ code: 0 });
    await repository(f, other, {
      "rig.yaml": `name: other
targets: { stable: true }
tools:
  cli:
    bin: cli.sh
`,
      "cli.sh": "#!/bin/sh\necho other\n",
    });
    expect(await f.rig(["init"], other)).toMatchObject({ code: 0 });
    const conflict = await f.rig(["deploy", "stable"], other);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain(
      "Project 'after' Target 'stable' Component 'cli' owns",
    );
  } finally {
    await f.cleanup();
  }
}, 60000);

const config = (name: string) => `name: ${name}
targets: { working: true, preview: true }
services:
  worker:
    command: /bin/sleep 3600
`;

test("a Project whose name differs only in case from a registered one is refused (#628)", async () => {
  const f = await rigFixture();
  try {
    await repository(f, f.repo, { "rig.yaml": config("alpha") });
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    const upper = join(f.base, "upper");
    await repository(f, upper, { "rig.yaml": config("ALPHA") });
    const refused = await f.rig(["init"], upper);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("only in case");
    const mixed = join(f.base, "mixed");
    await repository(f, mixed, { "rig.yaml": config("beta") });
    expect(await f.rig(["init"], mixed)).toMatchObject({ code: 0 });
    expect((await f.rig(["rename", "Alpha"], mixed)).code).toBe(1);
    expect(
      (await recorded(f)).projects.map((project: any) => project.name),
    ).toEqual(["alpha", "beta"]);
  } finally {
    await f.cleanup();
  }
}, 60000);

test("names over 128 characters are refused by init and rename, and 128 are selectable (#399)", async () => {
  const f = await rigFixture();
  try {
    await repository(f, f.repo, { "rig.yaml": config("a".repeat(129)) });
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect((await f.rig(["init"])).code).toBe(1);
    expect(
      (await recorded(f).catch(() => ({ projects: [] }))).projects,
    ).toEqual([]);
    await writeFile(join(f.repo, "rig.yaml"), config("short"));
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    expect((await f.rig(["rename", "b".repeat(129)])).code).toBe(1);
    expect(await readFile(join(f.repo, "rig.yaml"), "utf8")).toContain(
      "name: short",
    );
    const longest = "c".repeat(128);
    expect((await f.rig(["rename", longest])).code).toBe(0);
    expect(
      (await f.rig(["status", "--project", longest, "--json"], f.base)).code,
    ).toBe(0);
  } finally {
    await f.cleanup();
  }
}, 60000);

test("a new Preview may not take a spelling of a reserved name, nor differ only in case from another Preview (#593, #689)", async () => {
  const f = await rigFixture();
  try {
    const git = await repository(f, f.repo, { "rig.yaml": config("alpha") });
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    await git(["checkout", "-b", "feature"]);
    const deploy = (name: string) =>
      f.rig(["deploy", "preview", "feature", "--deployment", name, "--no-up"]);
    for (const name of ["DEV", "Dev", "all", "ALL", "Working"]) {
      const refused = await deploy(name);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("reserved");
    }
    expect(await deploy("feat")).toMatchObject({ code: 0 });
    const twin = await deploy("FEAT");
    expect(twin.code).toBe(1);
    expect(twin.stderr).toContain("'feat'");
    expect(
      (await recorded(f)).targets
        .filter((t: any) => t.kind === "preview")
        .map((t: any) => t.name),
    ).toEqual(["feat"]);
  } finally {
    await f.cleanup();
  }
}, 60000);
