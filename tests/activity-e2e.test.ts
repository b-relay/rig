import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";
test("daemon records observed terminal crashes once and exposes verified administration activity", async () => {
  const f = await rigFixture();
  try {
    await writeFile(
      join(f.repo, "app.ts"),
      "process.stdout.write('started\\n');setTimeout(()=>process.exit(7),750)",
    );
    await writeFile(
      join(f.repo, "rig.json"),
      JSON.stringify({
        name: "demo",
        local: { daemon: { keepAlive: false } },
        components: {
          worker: { mode: "managed", command: `'${process.execPath}' app.ts` },
        },
      }),
    );
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    expect(await f.rig(["up", "local"])).toMatchObject({ code: 0 });
    let activity = "";
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      activity = (await f.rig(["activity"])).stdout;
      if (/crash\s+failed/.test(activity)) break;
      await Bun.sleep(150);
    }
    expect(activity).toMatch(/daemon-install\s+installed/);
    expect(activity).toMatch(/crash\s+failed/);
    const status = await f.rig(["status", "--json"]);
    expect(
      JSON.parse(status.stdout).targets.find(
        (target: { name: string }) => target.name === "local",
      ),
    ).toMatchObject({ state: "failed", components: [{ state: "failed" }] });
    await Bun.sleep(5200);
    expect(
      (await f.rig(["activity"])).stdout.match(/crash\s+failed/g),
    ).toHaveLength(1);
    expect(await f.rig(["down", "local"])).toMatchObject({ code: 0 });
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 30000);
