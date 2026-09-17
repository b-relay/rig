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
services:
  web:
    run: "'${process.execPath}' server.ts"
    ports: { http: auto }
    ready: http://127.0.0.1:\${services.web.ports.http}
    env: { PORT: "\${services.web.ports.http}", DATA_DIR: "\${rig.data}" }
`,
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
    // Uncommitted working-copy policy never reaches the Stable Target: it restarts from its recorded plan.
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo
services:
  bad:
    run: exit 99
    ports: { http: 19999 }
`,
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
      replaced.plan.workspacePath,
    );
    expect(verified).toMatchObject({ code: 0 });
    // The superseded revision left with its replacement; only the current checkout remains.
    expect(await readdir(dirname(replaced.plan.workspacePath))).toEqual([
      basename(replaced.plan.workspacePath),
    ]);
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

test("CLI Preview destroy removes owned storage after stopping the real process while down preserves it", async () => {
  const f = await rigFixture();
  try {
    await f.git(["init", "-b", "main"]);
    await writeFile(join(f.repo, "server.ts"), `setInterval(() => {}, 1000);`);
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo
services:
  web:
    run: "'${process.execPath}' server.ts"
    env: { DATA_DIR: "\${rig.data}" }
`,
    );
    await f.commit();
    await f.git(["checkout", "-b", "review"]);
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    expect(
      await f.rig(["deploy", "preview", "review", "--deployment", "review"]),
    ).toMatchObject({ code: 0 });
    const target = JSON.parse(
      await readFile(join(f.root, "runtime", "state.json"), "utf8"),
    ).targets[0];
    const dataDir = target.plan.components.find((c: any) => c.name === "web")
      .env.DATA_DIR;
    expect(dataDir).toBe(join(target.plan.dataRoot, "web"));
    const database = join(dataDir, "app.db");
    await mkdir(dataDir, { recursive: true });
    await writeFile(database, "preview-owned bytes");
    expect(
      await f.rig(["down", "preview", "--deployment", "review"]),
    ).toMatchObject({ code: 0 });
    expect(await readFile(database, "utf8")).toBe("preview-owned bytes");
    expect(
      await f.rig(["up", "preview", "--deployment", "review"]),
    ).toMatchObject({ code: 0 });
    expect(
      await f.rig(["down", "preview", "--deployment", "review", "--destroy"]),
    ).toMatchObject({ code: 0 });
    expect(await Bun.file(database).exists()).toBe(false);
    expect(
      await Bun.file(join(target.plan.workspacePath, "server.ts")).exists(),
    ).toBe(false);
    expect(
      JSON.parse(await readFile(join(f.root, "runtime", "state.json"), "utf8"))
        .targets,
    ).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
}, 30000);
