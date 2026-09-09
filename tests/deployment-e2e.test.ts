import { test, expect } from "bun:test";
import { writeFile, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

test("real Branch deployment preserves policy, persistent data, no-op stops, and developer-repository independence", async () => {
  const f = await rigFixture();
  try {
    await f.git(["init", "-b", "main"]);
    await writeFile(
      join(f.repo, "server.ts"),
      `Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('first')});`,
    );
    await writeFile(
      join(f.repo, "rig.json"),
      JSON.stringify({
        name: "demo",
        components: {
          db: { uses: "sqlite" },
          web: {
            mode: "managed",
            command: `'${process.execPath}' server.ts`,
            health: "http://127.0.0.1:${web.port}",
            env: { PORT: "${web.port}" },
            dependsOn: ["db"],
          },
        },
      }),
    );
    let commit = await f.commit();
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    const deployed = await f.rig(["deploy", "live", "--json"]);
    expect(deployed).toMatchObject({ code: 0 });
    expect(JSON.parse(deployed.stdout)).toMatchObject({
      outcome: "deployed",
      branch: "main",
      commit,
    });
    const state = JSON.parse(
        await readFile(join(f.root, "runtime", "state.json"), "utf8"),
      ),
      target = state.targets[0];
    const persistent = target.plan.components.find(
      (c: any) => c.kind === "persistent",
    ).path;
    await writeFile(persistent, "precious database bytes");
    await writeFile(
      join(f.repo, "server.ts"),
      `Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('second')});`,
    );
    commit = await f.commit();
    const replacement = await f.rig(["deploy", "live", "--json"]);
    expect(replacement).toMatchObject({ code: 0 });
    const replaced = JSON.parse(
      await readFile(join(f.root, "runtime", "state.json"), "utf8"),
    ).targets[0];
    expect(
      replaced.plan.components.find((c: any) => c.name === "web").port,
    ).toBe(target.plan.components.find((c: any) => c.name === "web").port);
    expect(await f.rig(["down", "live", "--json"])).toMatchObject({ code: 0 });
    const noop = await f.rig(["deploy", "live", "--json"]);
    expect(JSON.parse(noop.stdout).outcome).toBe("unchanged");
    const status = JSON.parse((await f.rig(["status", "--json"])).stdout);
    expect(status.targets.find((t: any) => t.name === "live").state).toBe(
      "stopped",
    );
    await writeFile(
      join(f.repo, "rig.json"),
      JSON.stringify({
        name: "demo",
        components: {
          bad: { mode: "managed", command: "exit 99", port: 19999 },
        },
      }),
    );
    expect(await f.rig(["up", "live", "--json"])).toMatchObject({ code: 0 });
    const after = JSON.parse(
      (await f.rig(["status", "--json"])).stdout,
    ).targets.find((t: any) => t.name === "live");
    expect(after).toMatchObject({ branch: "main", commit, state: "healthy" });
    expect(await readFile(persistent, "utf8")).toBe("precious database bytes");
    await rename(f.repo, `${f.repo}-moved`);
    expect(
      await f.rig(["down", "live", "--project", "demo", "--json"], f.base),
    ).toMatchObject({ code: 0 });
    expect(
      await f.rig(["up", "live", "--project", "demo", "--json"], f.base),
    ).toMatchObject({ code: 0 });
    const verified = await f.run(
      ["git", "fsck", "--full"],
      target.plan.workspacePath,
    );
    expect(verified).toMatchObject({ code: 0 });
    expect(
      await f.rig(["down", "live", "--project", "demo"], f.base),
    ).toMatchObject({ code: 0 });
    await rename(`${f.repo}-moved`, f.repo);
  } finally {
    await f.cleanup();
  }
}, 30000);

test("offline doctor still reports daemon and independent config findings", async () => {
  const f = await rigFixture();
  try {
    const result = await f.rig(["doctor"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("daemon");
    expect(result.stdout).not.toContain("UNEXPECTED");
  } finally {
    await f.cleanup();
  }
});
