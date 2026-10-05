import { test, expect } from "bun:test";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
      join(f.repo, "rig.yaml"),
      `name: demo
targets: { working: true, stable: true }
services:
  web:
    command: "'${process.execPath}' server.ts"
    ports: { http: auto }
    healthcheck:
      test: http://127.0.0.1:\${services.web.ports.http}
    environment: { PORT: "\${services.web.ports.http}", DATA_DIR: "\${rig.data}" }
`,
    );
    let commit = await f.commit();
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    const deployed = await f.rig(["deploy", "stable", "--json"]);
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
    // ${rig.data} is the Service's directory under the Target's Persistent storage.
    const dataDir = target.plan.components.find((c: any) => c.name === "web")
      .env.DATA_DIR;
    expect(dataDir).toBe(join(target.plan.dataRoot, "web"));
    const persistent = join(dataDir, "app.db");
    await mkdir(dataDir, { recursive: true });
    await writeFile(persistent, "precious database bytes");
    await writeFile(
      join(f.repo, "server.ts"),
      `Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('second')});`,
    );
    commit = await f.commit();
    const replacement = await f.rig(["deploy", "stable", "--json"]);
    expect(replacement).toMatchObject({ code: 0 });
    const replaced = JSON.parse(
      await readFile(join(f.root, "runtime", "state.json"), "utf8"),
    ).targets[0];
    expect(
      replaced.plan.components.find((c: any) => c.name === "web").port,
    ).toBe(target.plan.components.find((c: any) => c.name === "web").port);
    expect(await f.rig(["down", "stable", "--json"])).toMatchObject({
      code: 0,
    });
    const noop = await f.rig(["deploy", "stable", "--json"]);
    expect(JSON.parse(noop.stdout).outcome).toBe("unchanged");
    const status = JSON.parse((await f.rig(["status", "--json"])).stdout);
    expect(status.targets.find((t: any) => t.name === "stable").state).toBe(
      "stopped",
    );
    // Uncommitted working-copy policy never reaches the Stable Target: it restarts from its recorded plan.
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo
targets: { working: true, stable: true }
services:
  bad:
    command: exit 99
    ports: { http: 19999 }
`,
    );
    expect(await f.rig(["up", "stable", "--json"])).toMatchObject({ code: 0 });
    const after = JSON.parse(
      (await f.rig(["status", "--json"])).stdout,
    ).targets.find((t: any) => t.name === "stable");
    expect(after).toMatchObject({ branch: "main", commit, state: "healthy" });
    expect(await readFile(persistent, "utf8")).toBe("precious database bytes");
    await rename(f.repo, `${f.repo}-moved`);
    expect(
      await f.rig(["down", "stable", "--project", "demo", "--json"], f.base),
    ).toMatchObject({ code: 0 });
    expect(
      await f.rig(["up", "stable", "--project", "demo", "--json"], f.base),
    ).toMatchObject({ code: 0 });
    const verified = await f.run(
      ["git", "fsck", "--full"],
      replaced.plan.workspacePath,
    );
    expect(verified).toMatchObject({ code: 0 });
    // The superseded revision left with its replacement; only the current checkout remains.
    expect(await readdir(dirname(replaced.plan.workspacePath))).toEqual([
      basename(replaced.plan.workspacePath),
    ]);
    expect(
      await f.rig(["down", "stable", "--project", "demo"], f.base),
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
