import { expect, test } from "bun:test";
import { mkdir, writeFile, rename, realpath } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

interface TargetReport {
  name: string;
  state: string;
  branch?: string;
  commit?: string;
  components: { name: string; state: string; port?: number }[];
}
interface AppReport {
  database: string;
  directory: string;
  value: string;
  setting: string;
}

test("a complete Project runs web, SQLite and installed CLI across local, live and Preview, then survives rename and repoint", async () => {
  const f = await rigFixture();
  let project = "demo";
  const success = (result: {
    code: number;
    stdout: string;
    stderr: string;
  }) => {
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return result.stdout;
  };
  const scope = () => ["--project", project];
  const status = async () =>
    JSON.parse(success(await f.rig(["status", ...scope(), "--json"], f.base)))
      .targets as TargetReport[];
  const target = async (name: string) => {
    const found = (await status()).find((value) => value.name === name);
    expect(found).toBeDefined();
    return found!;
  };
  const app = async (name: string, value?: string): Promise<AppReport> => {
    const report = await target(name);
    const port = report.components.find(
      (component) => component.name === "web",
    )?.port;
    expect(port).toBeGreaterThan(0);
    const response = await fetch(
      `http://127.0.0.1:${port}/${value === undefined ? "" : `?value=${encodeURIComponent(value)}`}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as AppReport;
  };
  const invoke = async (name: string) => {
    const output = success(
      await f.run([join(f.root, "bin", name), "argument with spaces"], f.base),
    );
    expect(JSON.parse(output)).toMatchObject({
      kind: "bundle-cli",
      argument: "argument with spaces",
    });
  };
  try {
    await f.git(["init", "-b", "main"]);
    await mkdir(join(f.repo, "cli"));
    await writeFile(
      join(f.repo, "cli", "shared.ts"),
      "export const kind = 'bundle-cli';\n",
    );
    await writeFile(
      join(f.repo, "cli", "main.ts"),
      "import {kind} from './shared'; process.stdout.write(JSON.stringify({kind,argument:process.argv[2],source:import.meta.dir})+'\\n');\n",
    );
    await writeFile(join(f.repo, ".env"), "SAFE_SETTING=fixture-literal\n");
    await writeFile(
      join(f.repo, "server.ts"),
      `
import {Database} from 'bun:sqlite';
const database = new Database(process.env.DATABASE!);
database.exec('CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
database.query('INSERT OR IGNORE INTO ledger (id,value) VALUES (1,?)').run('empty');
Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch(request){
 const url = new URL(request.url);
 if(url.pathname==='/health')return new Response('ready');
 if(url.searchParams.has('value'))database.query('UPDATE ledger SET value=? WHERE id=1').run(url.searchParams.get('value'));
 const row=database.query('SELECT value FROM ledger WHERE id=1').get() as {value:string};
 return Response.json({database:process.env.DATABASE,directory:process.cwd(),value:row.value,setting:process.env.SAFE_SETTING});
}});
process.stdout.write('bundle web ready\\n');
process.stderr.write('bundle diagnostic fixture\\n');
`,
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
            health: "http://127.0.0.1:${web.port}/health",
            envFile: ".env",
            env: { PORT: "${web.port}", DATABASE: "${db.path}" },
            dependsOn: ["db"],
          },
          tool: {
            mode: "installed",
            entrypoint: "cli/main.ts",
            installName: "bundle-tool",
          },
        },
      }),
    );
    const commit = await f.commit();
    await f.git(["branch", "feature/full"]);
    success(await f.rigd(["install"]));
    success(await f.rig(["init"]));
    expect(
      JSON.parse(success(await f.rig(["up", "local", "--json"]))),
    ).toMatchObject({ outcome: "started" });
    const local = await app("local", "local-preserved");
    expect(local).toMatchObject({
      directory: f.canonicalRepo,
      value: "local-preserved",
      setting: "fixture-literal",
    });
    await invoke("bundle-tool-dev");

    expect(
      JSON.parse(success(await f.rig(["deploy", "live", "--no-up", "--json"]))),
    ).toMatchObject({ outcome: "deployed", commit, branch: "main" });
    expect(await target("live")).toMatchObject({
      state: "stopped",
      commit,
      branch: "main",
    });
    const dormantPort = (await target("live")).components.find(
      (component) => component.name === "web",
    )!.port;
    await expect(
      fetch(`http://127.0.0.1:${dormantPort}`, {
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow();
    success(await f.rig(["up", "live"]));
    const live = await app("live", "live-preserved");
    expect(live.directory).not.toBe(f.canonicalRepo);
    await invoke("bundle-tool");
    expect(
      JSON.parse(success(await f.rig(["deploy", "live", "--json"]))),
    ).toMatchObject({ outcome: "unchanged", commit });

    expect(
      JSON.parse(
        success(
          await f.rig([
            "deploy",
            "preview",
            "feature/full",
            "--deployment",
            "battle",
            "--json",
          ]),
        ),
      ),
    ).toMatchObject({
      outcome: "deployed",
      target: "battle",
      commit,
      branch: "feature/full",
    });
    const preview = await app("battle", "preview-preserved");
    await invoke("bundle-tool-battle");
    expect(
      new Set([local.database, live.database, preview.database]).size,
    ).toBe(3);
    const running = await status();
    expect(running.map((report) => report.state)).toEqual([
      "healthy",
      "healthy",
      "healthy",
    ]);
    expect(
      new Set(
        running.map(
          (report) =>
            report.components.find((component) => component.name === "web")!
              .port,
        ),
      ).size,
    ).toBe(3);
    for (const report of running) {
      expect(
        report.components.find((component) => component.name === "db"),
      ).toMatchObject({ state: "ready" });
      expect(
        report.components.find((component) => component.name === "tool"),
      ).toMatchObject({ state: "installed" });
    }
    expect(
      JSON.parse(
        success(
          await f.rig([
            "deploy",
            "preview",
            "feature/full",
            "--deployment",
            "battle",
            "--json",
          ]),
        ),
      ),
    ).toMatchObject({ outcome: "unchanged" });
    for (const args of [
      ["local"],
      ["live"],
      ["preview", "--deployment", "battle"],
    ]) {
      success(await f.rig(["down", ...args]));
      const logs = success(await f.rig(["logs", ...args]));
      expect(logs).toContain("bundle web ready");
      expect(logs).toContain("bundle diagnostic fixture");
    }
    expect((await status()).every((report) => report.state === "stopped")).toBe(
      true,
    );
    success(await f.rig(["rename", "renamed"]));
    project = "renamed";
    expect(await f.git(["remote", "get-url", "rig"])).toBe(
      "rig://localhost/renamed",
    );
    const moved = join(f.base, "moved-project");
    await rename(f.repo, moved);
    success(await f.rig(["repoint", moved, ...scope()], f.base));
    for (const args of [
      ["local"],
      ["live"],
      ["preview", "--deployment", "battle"],
    ])
      success(await f.rig(["up", ...args, ...scope()], f.base));
    expect(await app("local")).toMatchObject({
      database: local.database,
      directory: await realpath(moved),
      value: "local-preserved",
    });
    expect(await app("live")).toMatchObject({
      database: live.database,
      directory: live.directory,
      value: "live-preserved",
    });
    expect(await app("battle")).toMatchObject({
      database: preview.database,
      directory: preview.directory,
      value: "preview-preserved",
    });
    await invoke("bundle-tool-dev");
    await invoke("bundle-tool");
    await invoke("bundle-tool-battle");
  } finally {
    for (const name of new Set([project, "demo", "renamed"])) {
      for (const args of [
        ["local"],
        ["live"],
        ["preview", "--deployment", "battle", "--destroy"],
      ])
        await f
          .rig(["down", ...args, "--project", name], f.base)
          .catch(() => {});
    }
    await f.cleanup();
  }
}, 60000);
