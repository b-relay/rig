import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";
test("daemon records observed terminal crashes once and exposes verified administration activity", async () => {
  const f = await rigFixture();
  try {
    // It crashes only once told to, after up has counted it started, however loaded the Host.
    const crash = join(f.base, "crash");
    await writeFile(
      join(f.repo, "app.ts"),
      `import {existsSync} from "node:fs";process.stdout.write('started\\n');setInterval(()=>{if(existsSync(${JSON.stringify(crash)}))process.exit(7)},20)`,
    );
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo
services:
  worker:
    run: "'${process.execPath}' app.ts"
    restart: "no"
`,
    );
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    expect(await f.rig(["up", "local"])).toMatchObject({ code: 0 });
    await writeFile(crash, "");
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
    // rigd's supervision pass, every second, sees the ended process again; the crash stays recorded once. Two passes show it
    // against the real daemon; activity-crashes.test.ts proves it for any number of passes.
    for (const settled = Date.now() + 2200; Date.now() < settled;) {
      expect(
        (await f.rig(["activity"])).stdout.match(/crash\s+failed/g),
      ).toHaveLength(1);
      await Bun.sleep(200);
    }
    expect(await f.rig(["down", "local"])).toMatchObject({ code: 0 });
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 60000);
