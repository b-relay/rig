import { test, expect } from "bun:test";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

const CONFIG = `name: demo
services:
  api:
    command: sleep 120
targets:
  working: true
`;

test("rig down from the Project's directory stops its recorded Target whatever is wrong with rig.yaml, and says so, while up still refuses", async () => {
  const f = await rigFixture();
  const breakages = [
    {
      name: "an unknown field",
      cwd: f.repo,
      apply: () => appendFile(join(f.repo, "rig.yaml"), "unknown: 123\n"),
      note: 'Fix config: has no field named "unknown".',
    },
    {
      name: "malformed YAML",
      cwd: join(f.repo, "src"),
      apply: () =>
        writeFile(join(f.repo, "rig.yaml"), "name: demo\nservices: [\n"),
      note: "Invalid or unsupported YAML syntax.",
    },
    {
      name: "no rig.yaml",
      cwd: join(f.repo, "src"),
      apply: () => rm(join(f.repo, "rig.yaml")),
      note: "No rig.yaml found.",
    },
  ];
  try {
    await writeFile(join(f.repo, "rig.yaml"), CONFIG);
    await mkdir(join(f.repo, "src"));
    await writeFile(join(f.repo, "src", ".keep"), "");
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    for (const breakage of breakages) {
      await writeFile(join(f.repo, "rig.yaml"), CONFIG);
      expect(await f.rig(["up"])).toMatchObject({ code: 0 });
      await breakage.apply();
      // Starting plans from rig.yaml, so it still fails on it.
      expect((await f.rig(["up"], breakage.cwd)).code).toBe(1);
      const down = await f.rig(["down"], breakage.cwd);
      expect({ breakage: breakage.name, code: down.code }).toEqual({
        breakage: breakage.name,
        code: 0,
      });
      expect(down.stdout).toContain("demo working stopped");
      expect(down.stdout).toContain(
        "Warning: rig.yaml could not be used, so working was stopped as it was recorded.",
      );
      expect(down.stdout).toContain(breakage.note);
      const status = JSON.parse(
        (await f.rig(["status", "--project", "demo", "--json"])).stdout,
      ) as { targets: { name: string; state: string }[] };
      expect(
        status.targets.find((target) => target.name === "working")?.state,
      ).toBe("stopped");
    }
    await writeFile(join(f.repo, "rig.yaml"), CONFIG);
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 120000);
