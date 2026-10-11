import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

/* ADR 0016 end to end, modelled on Melody: real rigd, real Git, real processes under an isolated RIG_ROOT. `db` runs a
 * script from the repository and watches only it; `search` runs a server outside the repository and watches nothing; `api`
 * depends on both and `web` on `api`, and both compare the whole checkout. */

type Fixture = Awaited<ReturnType<typeof rigFixture>>;
const SERVER = `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response(process.env.NAME ?? "ok") });\n`;
const bun = process.execPath;

async function stableStatus(f: Fixture) {
  const status = JSON.parse((await f.rig(["status", "--json"])).stdout);
  return status.targets.find((t: { name: string }) => t.name === "stable") as {
    commit: string;
    state: string;
    components: { name: string; pid?: number; commit?: string }[];
  };
}
async function pids(f: Fixture): Promise<Record<string, number | undefined>> {
  const stable = await stableStatus(f);
  return Object.fromEntries(stable.components.map((c) => [c.name, c.pid]));
}
async function deploy(f: Fixture) {
  const result = await f.rig(["deploy", "stable", "--json"]);
  expect(result).toMatchObject({ code: 0 });
  return JSON.parse(result.stdout) as {
    outcome: string;
    commit: string;
    kept: string[];
    restarted: { service: string; reason: string }[];
  };
}

test("Melody: a web-only change keeps db and search running with the same pids; a change to db's script restarts db and its dependents", async () => {
  const f = await rigFixture();
  try {
    // search is an absolute binary outside the checkout, as Typesense is.
    const outside = join(f.base, "opt");
    await mkdir(outside);
    await writeFile(join(outside, "server.ts"), SERVER);
    await mkdir(join(f.repo, "scripts"));
    await writeFile(
      join(f.repo, "scripts", "rig-postgres.sh"),
      `# version 1\nexec '${bun}' '${join(outside, "server.ts")}'\n`,
    );
    await writeFile(join(f.repo, "api.ts"), SERVER);
    await writeFile(join(f.repo, "web.ts"), SERVER);
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: melody
targets: { stable: true }
services:
  db:
    command: sh scripts/rig-postgres.sh
    ports: { postgres: auto }
    environment: { PORT: "\${port}", NAME: db }
    watch: [scripts/rig-postgres.sh]
  search:
    command: exec '${bun}' '${join(outside, "server.ts")}'
    ports: { http: auto }
    environment: { PORT: "\${port}", NAME: search }
    watch: []
  api:
    command: exec '${bun}' api.ts
    ports: { http: auto }
    environment: { PORT: "\${port}", NAME: api }
    depends_on: [db, search]
  web:
    command: exec '${bun}' web.ts
    ports: { http: auto }
    environment: { PORT: "\${port}", NAME: web }
    depends_on: [api]
`,
    );
    await f.git(["init", "-b", "main"]);
    const first = await f.commit();
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    expect(await deploy(f)).toMatchObject({
      outcome: "deployed",
      commit: first,
      kept: [],
    });
    const started = await pids(f);
    for (const service of ["db", "search", "api", "web"])
      expect(started[service]).toBeNumber();

    // A web-only change: db and search keep their processes; api and web compare the whole checkout and restart.
    await writeFile(join(f.repo, "web.ts"), `// v2\n${SERVER}`);
    const second = await f.commit();
    expect(await deploy(f)).toMatchObject({
      outcome: "deployed",
      commit: second,
      kept: ["db", "search"],
      restarted: [
        { service: "api", reason: "files" },
        { service: "web", reason: "files" },
      ],
    });
    const afterWeb = await pids(f);
    expect(afterWeb.db).toBe(started.db);
    expect(afterWeb.search).toBe(started.search);
    expect(afterWeb.api).not.toBe(started.api);
    expect(afterWeb.web).not.toBe(started.web);
    const stable = await stableStatus(f);
    expect(stable.commit).toBe(second);
    expect(
      Object.fromEntries(stable.components.map((c) => [c.name, c.commit])),
    ).toEqual({ db: first, search: first, api: second, web: second });
    const text = (await f.rig(["status"])).stdout;
    expect(text).toMatch(new RegExp(`db .*kept from ${first.slice(0, 7)}`));
    expect(text).toMatch(new RegExp(`search .*kept from ${first.slice(0, 7)}`));
    // The human line names what it kept.
    await writeFile(join(f.repo, "web.ts"), `// v3\n${SERVER}`);
    await f.commit();
    expect((await f.rig(["deploy", "stable"])).stdout).toContain(
      ", kept db, search",
    );
    const afterThird = await pids(f);
    expect(afterThird.db).toBe(started.db);

    // A change to db's script restarts db, and api and web with it; search, which depends on nothing, keeps running.
    await writeFile(
      join(f.repo, "scripts", "rig-postgres.sh"),
      `# version 2\nexec '${bun}' '${join(outside, "server.ts")}'\n`,
    );
    const fourth = await f.commit();
    expect(await deploy(f)).toMatchObject({
      outcome: "deployed",
      commit: fourth,
      kept: ["search"],
    });
    const afterScript = await pids(f);
    expect(afterScript.search).toBe(started.search);
    expect(afterScript.db).not.toBe(started.db);
    expect(afterScript.api).not.toBe(afterThird.api);
    expect(afterScript.web).not.toBe(afterThird.web);
    expect((await stableStatus(f)).state).toBe("running");

    // search still runs in the first checkout, which is held; the ones nothing runs in are gone.
    const state = JSON.parse(
      await readFile(join(f.root, "runtime", "state.json"), "utf8"),
    );
    const target = state.targets.find(
      (t: { kind: string }) => t.kind === "stable",
    );
    const revisions: string = target.sourceRoot;
    expect((await readdir(revisions)).sort()).toEqual(
      [target.services.search.source.checkout, target.plan.workspacePath]
        .map((path: string) => path.slice(revisions.length + 1))
        .sort(),
    );
    expect(state.deployments.at(-1)).toMatchObject({
      commit: fourth,
      kept: ["search"],
    });

    // rig restart starts every Service from the current checkout and gives the held one back.
    expect(await f.rig(["restart", "stable"])).toMatchObject({ code: 0 });
    expect(await readdir(revisions)).toEqual([
      target.plan.workspacePath.slice(revisions.length + 1),
    ]);
    expect((await pids(f)).search).not.toBe(started.search);
    expect(await f.rig(["down", "stable"])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 120000);
