import { describe, expect, test } from "bun:test";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

type Fixture = Awaited<ReturnType<typeof rigFixture>>;

const TOOL = "#!/bin/sh\necho tool\n";
const config = (name: string, tools: string) =>
  `name: ${name}\ntargets: { working: true, stable: true }\nservices:\n  sleeper: { command: /bin/sleep 600, stop_timeout: 1s }\n${tools}`;
const tool = (name: string) => `tools:\n  ${name}:\n    bin: tool.sh\n`;

async function repository(f: Fixture, cwd: string, rigYaml: string) {
  await writeFile(join(cwd, "rig.yaml"), rigYaml);
  await writeFile(join(cwd, "tool.sh"), TOOL, { mode: 0o755 });
  expect(await f.rig(["init", "--create-git"], cwd)).toMatchObject({ code: 0 });
}
const states = async (f: Fixture, cwd: string) =>
  JSON.parse((await f.rig(["status", "--json"], cwd)).stdout).targets.flatMap(
    (target: { name: string; components: Record<string, string>[] }) =>
      target.components.map(
        (component) => `${target.name}/${component.name}=${component.state}`,
      ),
  ) as string[];

describe("rigd uninstall and Tools (#678)", () => {
  test("a stopped Project whose Tool an edit left unknown uninstalls, with its Tool and registration kept; a running Service is refused by name", async () => {
    const f = await rigFixture();
    try {
      expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
      await repository(f, f.repo, config("demo", tool("probe")));
      expect(await f.rig(["up"])).toMatchObject({ code: 0 });

      const running = await f.rigd(["uninstall"]);
      expect(running.code).toBe(1);
      expect(running.stderr).toContain("demo working (sleeper is ");
      expect(running.stderr).toContain("rig down working --project demo");

      expect(await f.rig(["down"])).toMatchObject({ code: 0 });
      await writeFile(join(f.repo, "tool.sh"), "#!/bin/sh\necho edited\n");
      expect(await states(f, f.repo)).toContain("working/probe=unknown");

      expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
      expect(await readFile(join(f.root, "bin", "probe-dev"), "utf8")).toBe(
        TOOL,
      );
      // The next install finds the Project as it was, and a second uninstall has nothing to do.
      expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
      expect((await f.rig(["list"])).stdout).toContain("demo");
      expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
      expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  test("a deployed Target whose checkout is gone uninstalls without restoring it or forgetting the Project", async () => {
    const f = await rigFixture();
    try {
      expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
      await repository(f, f.repo, config("demo", tool("probe")));
      await f.commit();
      expect(await f.rig(["deploy", "stable"])).toMatchObject({ code: 0 });
      expect(await f.rig(["down", "stable"])).toMatchObject({ code: 0 });
      const { targets } = JSON.parse(
        await readFile(join(f.root, "runtime", "state.json"), "utf8"),
      ) as {
        targets: { kind: string; plan: { workspacePath: string } }[];
      };
      const { workspacePath } = targets.find((t) => t.kind === "stable")!.plan;
      await rename(workspacePath, `${workspacePath}.moved`);
      expect(
        (await states(f, f.repo)).find((s) => s.startsWith("stable/probe=")),
      ).not.toBe("stable/probe=installed");

      expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
      expect(await readFile(join(f.root, "bin", "probe"), "utf8")).toBe(TOOL);
    } finally {
      await f.cleanup();
    }
  }, 60_000);
});

describe("a Project refused a Tool another Project owns (#629)", () => {
  /** alpha publishes the Tool and keeps running; beta asks for it, is refused, then corrects its rig.yaml to `corrected`. */
  async function refused(f: Fixture, corrected: string) {
    const [alpha, beta] = [join(f.base, "alpha"), join(f.base, "beta")];
    await Bun.$`mkdir -p ${alpha} ${beta}`.quiet();
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    await repository(f, alpha, config("alpha", tool("samecli")));
    expect(await f.rig(["up"], alpha)).toMatchObject({ code: 0 });
    await repository(f, beta, config("beta", tool("samecli")));
    const conflict = await f.rig(["up"], beta);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("Project 'alpha'");
    await writeFile(join(beta, "rig.yaml"), config("beta", corrected));
    return { alpha, beta };
  }
  /** Every file of Tool ownership, for "the owner's Tool is intact". */
  const owned = async (f: Fixture) => {
    const owners = join(f.root, "installed", "owners");
    const records: Record<string, string> = {};
    for (const name of await readdir(owners))
      records[name] = await readFile(join(owners, name), "utf8");
    return {
      records,
      executable: await readFile(join(f.root, "bin", "samecli-dev"), "utf8"),
    };
  };

  test.each([
    ["drops the Tool", "up", "", undefined],
    ["drops the Tool", "restart", "", undefined],
    ["renames the Tool", "up", tool("differentcli"), "differentcli-dev"],
    ["renames the Tool", "restart", tool("differentcli"), "differentcli-dev"],
  ] as const)(
    "a claimant that %s starts with rig %s, its Services running and the owner's Tool intact",
    async (_change, action, corrected, published) => {
      const f = await rigFixture();
      try {
        const { alpha, beta } = await refused(f, corrected);
        const before = await owned(f);

        expect(await f.rig([action], beta)).toMatchObject({ code: 0 });
        const seen = await states(f, beta);
        expect(
          seen.filter((state) => state.startsWith("working/sleeper=")),
        ).toEqual(["working/sleeper=running"]);
        const after = await owned(f);
        expect(after.executable).toBe(before.executable);
        for (const [name, record] of Object.entries(before.records))
          expect(after.records[name]).toBe(record);
        if (published)
          expect(await readFile(join(f.root, "bin", published), "utf8")).toBe(
            TOOL,
          );
        expect((await f.run([join(f.root, "bin", "samecli-dev")])).stdout).toBe(
          "tool\n",
        );

        for (const cwd of [alpha, beta])
          expect(await f.rig(["down"], cwd)).toMatchObject({ code: 0 });
      } finally {
        await f.cleanup();
      }
    },
    60_000,
  );
});
