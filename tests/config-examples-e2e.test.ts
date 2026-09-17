import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

type Fixture = Awaited<ReturnType<typeof rigFixture>>;
const example = (name: string) =>
  join(import.meta.dir, "..", "plans", "examples", `114-${name}.rig.yaml`);
const toolOnly = (name: string, extra = "") =>
  `name: ${name}\n${extra}tools:\n  cli:\n    bin: cli.sh\n`;

/** A second Project directory served by the fixture's one isolated daemon. */
async function directory(f: Fixture, name: string): Promise<string> {
  const path = join(f.base, name);
  await mkdir(path);
  return path;
}
/** Every file of a directory with its bytes, so "untouched" covers the listing and the contents. */
async function snapshot(path: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(path)).sort())
    files[name] = await readFile(join(path, name), "utf8");
  return files;
}
async function targets(f: Fixture, cwd: string) {
  const status = await f.rig(["status", "--json"], cwd);
  expect(status).toMatchObject({ code: 0 });
  return JSON.parse(status.stdout).targets as {
    name: string;
    state: string;
    route?: string;
    components: { name: string; state: string }[];
  }[];
}

test("the Tool-only and multi-Service examples initialize and are inspected under their own Target names", async () => {
  const f = await rigFixture();
  try {
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    const tool = await directory(f, "report");
    await copyFile(example("tool"), join(tool, "rig.yaml"));
    const original = await readFile(join(tool, "rig.yaml"), "utf8");
    expect(await f.rig(["init", "--create-git"], tool)).toMatchObject({
      code: 0,
    });
    expect(await readFile(join(tool, "rig.yaml"), "utf8")).toBe(original);
    const reported = await targets(f, tool);
    expect(reported.map((target) => target.name).sort()).toEqual([
      "live",
      "local",
    ]);
    // A Tool-only Project is exactly its Tool: no Service, port, hostname or route is invented for it.
    for (const target of reported) {
      expect(target.components).toEqual([
        expect.objectContaining({ name: "report", state: "configured" }),
      ]);
      expect(target.route).toBeUndefined();
    }
    const config = await f.rig(["config"], tool);
    expect(config).toMatchObject({ code: 0 });
    expect(config.stdout).toContain(".rig-build/report");
    expect(config.stdout).not.toContain("services");
    expect(config.stdout).not.toContain("domain");

    const multi = await directory(f, "acme");
    await copyFile(example("multi"), join(multi, "rig.yaml"));
    expect(await f.rig(["init", "--create-git"], multi)).toMatchObject({
      code: 0,
    });
    const renamed = await targets(f, multi);
    expect(renamed.map((target) => target.name).sort()).toEqual([
      "dev",
      "production",
    ]);
    for (const target of renamed)
      expect(
        target.components.map((component) => component.name).sort(),
      ).toEqual(["acmectl", "api", "db", "web"]);
    const text = (await f.rig(["status"], multi)).stdout;
    expect(text).toMatch(/^dev\b/m);
    expect(text).toMatch(/^production\b/m);
    expect(text).not.toMatch(/^(local|live)\b/m);
    // The default names select nothing once the pair is renamed; the configured names do.
    const unknown = await f.rig(["down", "live"], multi);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no Target named 'live'");
    expect(unknown.stderr).toContain("Select dev, production or preview.");
    const selected = await f.rig(["down", "production"], multi);
    expect(selected.stderr).toContain(
      "Target 'production' has no recorded deployment.",
    );
  } finally {
    await f.cleanup();
  }
}, 60000);

test("retired JSON, the retired component schema, malformed YAML and a Host config.json are refused without changing a byte", async () => {
  const f = await rigFixture();
  try {
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    const cases = [
      {
        name: "json-only",
        file: "rig.json",
        raw: JSON.stringify({ name: "legacy", components: {} }),
        message: "rig.json is a retired configuration format",
      },
      {
        name: "old-schema",
        file: "rig.yaml",
        raw: "name: legacy\ncomponents:\n  web:\n    mode: managed\n    command: serve\n",
        message: "retired component schema",
      },
      {
        name: "malformed",
        file: "rig.yaml",
        raw: "name: legacy\nservices: [unclosed\n",
        message: undefined,
      },
    ];
    for (const entry of cases) {
      const path = await directory(f, entry.name);
      await writeFile(join(path, entry.file), entry.raw);
      const before = await snapshot(path);
      for (const args of [
        ["init", "--create-git"],
        ["init", "--create-git", "--tool", "cli", "--bin", "cli.sh"],
      ]) {
        const result = await f.rig(args, path);
        expect(result.code).not.toBe(0);
        const output = result.stdout + result.stderr;
        expect(output).toContain(join(entry.name, entry.file));
        if (entry.message) expect(output).toContain(entry.message);
      }
      // Neither a repository nor a converted or scaffolded config appears.
      expect(await snapshot(path)).toEqual(before);
    }
    expect((await f.rig(["list", "--json"])).stdout).not.toContain("legacy");

    const hostJson = join(f.root, "config.json");
    const hostRaw = JSON.stringify({ deploy: { productionBranch: "trunk" } });
    await writeFile(hostJson, hostRaw);
    const valid = await directory(f, "valid");
    await writeFile(join(valid, "rig.yaml"), toolOnly("valid"));
    const refused = await f.rig(["init", "--create-git"], valid);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain(
      "config.json is a retired configuration format",
    );
    expect(await readFile(hostJson, "utf8")).toBe(hostRaw);
    expect(await Bun.file(join(f.root, "config.yaml")).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 60000);

test("the Host productionBranch is a Project's Production Branch until the Project sets production_branch", async () => {
  const f = await rigFixture();
  try {
    await mkdir(f.root, { recursive: true });
    await writeFile(
      join(f.root, "config.yaml"),
      "deploy:\n  productionBranch: trunk\n",
    );
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    for (const [name, extra, production] of [
      ["inherits", "", "trunk"],
      ["chooses", "production_branch: release\n", "release"],
    ] as const) {
      const path = await directory(f, name);
      await writeFile(join(path, "rig.yaml"), toolOnly(name, extra));
      expect(await f.rig(["init", "--create-git"], path)).toMatchObject({
        code: 0,
      });
      await f.run(["git", "checkout", "-q", "-b", "work"], path);
      // Without a terminal, a Stable deploy from another Branch is refused by naming the Production Branch; nothing is deployed.
      const refused = await f.rig(["deploy", "live"], path);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`Production '${production}'`);
      expect(refused.stderr).toContain(`rig deploy live ${production}`);
      expect(await targets(f, path)).not.toContainEqual(
        expect.objectContaining({ name: "live", state: "stopped" }),
      );
    }
  } finally {
    await f.cleanup();
  }
}, 60000);

test("a deployed Commit that still carries rig.json or the retired schema is refused even though the checkout's rig.yaml is valid, and no Stable Target is recorded", async () => {
  const f = await rigFixture();
  try {
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    const valid = toolOnly("demo");
    const legacyJson = JSON.stringify({ name: "demo", components: {} });
    await writeFile(join(f.repo, "cli.sh"), "#!/bin/sh\necho report\n", {
      mode: 0o755,
    });
    await writeFile(join(f.repo, "rig.yaml"), valid);
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    for (const [committed, code, message] of [
      [
        { "rig.yaml": valid, "rig.json": legacyJson },
        "LEGACY_FORMAT",
        "rig.json is a retired configuration format.",
      ],
      [
        { "rig.yaml": "name: demo\ncomponents: {}\n" },
        "LEGACY_CONFIG",
        "This Project config uses the retired component schema.",
      ],
    ] as const) {
      for (const [file, raw] of Object.entries(committed))
        await writeFile(join(f.repo, file), raw);
      const commit = await f.commit();
      // The checkout is converted but not committed: the deploy reads the Commit, never the working copy.
      await rm(join(f.repo, "rig.json"), { force: true });
      await writeFile(join(f.repo, "rig.yaml"), valid);
      const branch = await f.git(["branch", "--show-current"]);
      const refused = await f.rig([
        "deploy",
        "live",
        branch,
        "--no-up",
        "--json",
      ]);
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({
        error: {
          code,
          message: `The deployed Commit carries retired configuration. ${message}`,
          hint: "Commit rig.yaml in the current schema, without rig.json beside it, then deploy that Commit.",
        },
      });
      expect(await targets(f, f.repo)).toEqual([
        expect.objectContaining({ name: "local", state: "configured" }),
        expect.objectContaining({ name: "live", state: "configured" }),
      ]);
      const recorded = JSON.parse(
        await readFile(join(f.root, "runtime", "state.json"), "utf8"),
      ).targets as { kind: string; commit?: string }[];
      expect(recorded.filter((target) => target.kind === "live")).toEqual([]);
      expect(JSON.stringify(recorded)).not.toContain(commit);
      await f.git(["rm", "-q", "--cached", "--ignore-unmatch", "rig.json"]);
    }
  } finally {
    await f.cleanup();
  }
}, 60000);
