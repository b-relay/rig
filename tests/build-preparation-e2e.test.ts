import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

/** How many times each counted command ran: one line per run, in run order across units. */
async function runs(counts: string): Promise<string[]> {
  return (await readFile(join(counts, "order"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
}

test("deploy --no-up builds every unit once and starts nothing; up and restart reuse that preparation; force builds a fresh scope", async () => {
  const f = await rigFixture();
  const counts = join(f.base, "counts");
  const json = async (args: string[]) => {
    const result = await f.rig([...args, "--json"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return JSON.parse(result.stdout);
  };
  const live = async () =>
    (await json(["status"])).targets.find(
      (target: { name: string }) => target.name === "live",
    );
  try {
    await mkdir(counts);
    await f.git(["init", "-b", "main"]);
    await writeFile(
      join(f.repo, "server.ts"),
      `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(join(counts, "order"))}, 'run:web\\n');
Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response(String(Bun.file('web.built').size))});`,
    );
    await writeFile(
      join(f.repo, "cli.ts"),
      "process.stdout.write('tool\\n');\n",
    );
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo
build: echo shared >> '${counts}/order'
services:
  web:
    build: echo service:web >> '${counts}/order' && echo built > web.built
    run: "'${process.execPath}' server.ts"
    ports: { http: auto }
    ready: http://127.0.0.1:\${services.web.ports.http}
    env: { PORT: "\${services.web.ports.http}" }
tools:
  counted:
    build: echo tool:counted >> '${counts}/order'
    bin: cli.ts
`,
    );
    await f.commit();
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });

    expect(await json(["deploy", "live", "--no-up"])).toMatchObject({
      outcome: "deployed",
    });
    // Shared first, then the Service, then the Tool; no Service process ran.
    expect(await runs(counts)).toEqual([
      "shared",
      "service:web",
      "tool:counted",
    ]);
    expect((await live()).state).toBe("stopped");

    expect(await json(["up", "live"])).toMatchObject({ outcome: "started" });
    expect(await json(["restart", "live"])).toMatchObject({
      outcome: "started",
    });
    expect(await runs(counts)).toEqual([
      "shared",
      "service:web",
      "tool:counted",
      "run:web",
      "run:web",
    ]);

    // The same Commit again is a completed no-op; force prepares a fresh Deployment.
    expect(await json(["deploy", "live"])).toMatchObject({
      outcome: "unchanged",
    });
    expect((await runs(counts)).length).toBe(5);
    expect(await json(["deploy", "live", "--force"])).toMatchObject({
      outcome: "deployed",
    });
    expect((await runs(counts)).slice(5)).toEqual([
      "shared",
      "service:web",
      "tool:counted",
      "run:web",
    ]);
    expect(await f.rig(["down", "live"])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 60000);

test("a pushed Production Branch deploys the renamed Stable Target with the plain Tool command; the deployment keeps its committed policy, reads env files fresh without rebuilding, and a changed Working copy config is reported as drift", async () => {
  const f = await rigFixture();
  const counts = join(f.base, "counts"),
    bin = join(f.base, "helper-bin"),
    secrets = join(f.base, "secrets.env");
  const ok = async (args: string[]) => {
    const result = await f.rig([...args, "--json"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return JSON.parse(result.stdout);
  };
  const config = (run: string) => `name: demo
env_file: ['${secrets}']
targets:
  working: { name: devbox }
  stable: { name: prod }
services:
  web:
    build: echo service:web >> '${counts}/order'
    run: "${run}"
    ports: { http: auto }
    ready: http://127.0.0.1:\${services.web.ports.http}
    env: { PORT: "\${services.web.ports.http}" }
tools:
  counted:
    build: echo tool:counted >> '${counts}/order'
    bin: cli.ts
`;
  const served = async (target: string) => {
    const report = (await ok(["status"])).targets.find(
      (entry: { name: string }) => entry.name === target,
    );
    const port = report.components.find(
      (component: { name: string }) => component.name === "web",
    ).port;
    return await (await fetch(`http://127.0.0.1:${port}`)).text();
  };
  try {
    await mkdir(counts);
    await mkdir(bin);
    await writeFile(
      join(bin, "git-remote-rig"),
      `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../src/git/remote-helper.ts")}' "$@"\n`,
    );
    await chmod(join(bin, "git-remote-rig"), 0o755);
    await writeFile(secrets, "GREETING=first\n", { mode: 0o600 });
    await f.git(["init", "-b", "main"]);
    await writeFile(
      join(f.repo, "server.ts"),
      "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response(process.env.GREETING)});",
    );
    await writeFile(
      join(f.repo, "cli.ts"),
      "process.stdout.write('tool\\n');\n",
    );
    await writeFile(
      join(f.repo, "rig.yaml"),
      config(`'${process.execPath}' server.ts`),
    );
    await f.commit();
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });

    const pushed = await f.run([
      "env",
      `PATH=${bin}:${process.env.PATH}`,
      "git",
      "push",
      "rig",
      "main",
    ]);
    expect(pushed.stderr).toContain("demo main deployed to prod");
    expect(pushed.code).toBe(0);
    expect(await runs(counts)).toEqual(["service:web", "tool:counted"]);
    expect(await served("prod")).toBe("first");
    expect(await f.run([join(f.root, "bin", "counted")], f.base)).toMatchObject(
      { code: 0, stdout: "tool\n" },
    );

    // The checkout's config now names a command that cannot run, and the env file carries a new value.
    await writeFile(join(f.repo, "rig.yaml"), config("exit 9"));
    await writeFile(secrets, "GREETING=rotated\n", { mode: 0o600 });
    expect(await ok(["restart", "prod"])).toMatchObject({ outcome: "started" });
    expect(await served("prod")).toBe("rotated");
    expect(await runs(counts)).toEqual(["service:web", "tool:counted"]);

    // The Working copy publishes its own alias under its configured name, from a build of current source.
    await writeFile(
      join(f.repo, "rig.yaml"),
      config(`'${process.execPath}' server.ts`),
    );
    expect(await ok(["up", "devbox"])).toMatchObject({ outcome: "started" });
    expect((await runs(counts)).slice(2)).toEqual([
      "service:web",
      "tool:counted",
    ]);
    expect(
      await f.run([join(f.root, "bin", "counted-devbox")], f.base),
    ).toMatchObject({ code: 0, stdout: "tool\n" });
    await writeFile(
      join(f.repo, "rig.yaml"),
      config(`'${process.execPath}' server.ts`) + "description: changed\n",
    );
    const drifted = await ok(["up", "devbox"]);
    expect(drifted.warnings).toEqual([
      expect.stringContaining("Run rig restart devbox"),
    ]);
    // The running Service was not rebuilt; the Tool was.
    expect((await runs(counts)).slice(4)).toEqual(["tool:counted"]);
    const restarted = await ok(["restart", "devbox"]);
    expect(restarted.warnings ?? []).toEqual([]);
    for (const target of ["devbox", "prod"])
      expect(await f.rig(["down", target])).toMatchObject({ code: 0 });
  } finally {
    await f.cleanup();
  }
}, 90000);
