import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

test("a changed providers.caddy applies at a Target's next start, with no rigd install: the route file, extra_config and reload command", async () => {
  // A `caddy` that accepts every route file, first on PATH: no real Caddy is contacted.
  const bin = await mkdtemp("/tmp/rig-ext-caddy-");
  await writeFile(join(bin, "caddy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const f = await rigFixture({ PATH: `${bin}:${process.env.PATH}` });
  const evidence = join(f.base, "reloads");
  const configure = (name: string) =>
    writeFile(
      join(f.root, "config.yaml"),
      [
        "dashboard: false",
        "providers:",
        "  caddy:",
        `    caddyfile: ${join(f.base, `${name}.caddy`)}`,
        `    host_caddyfile: ${join(f.base, "host.caddy")}`,
        `    extra_config: ["header X-Probe ${name}"]`,
        "    reload:",
        "      mode: command",
        `      command: "printf '${name}\\\\n' >> ${evidence}"`,
        "",
      ].join("\n"),
    );
  const ok = (result: { code: number; stdout: string; stderr: string }) => {
    expect(result).toMatchObject({ code: 0 });
    return result.stdout;
  };
  try {
    await mkdir(f.root, { recursive: true });
    await configure("first");
    await writeFile(
      join(f.repo, "server.ts"),
      "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('ok')});\n",
    );
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo
targets:
  working:
    domain: rig.528.test
services:
  web:
    command: "'${process.execPath}' server.ts"
    ports: { http: auto }
    environment:
      PORT: "\${services.web.ports.http}"
`,
    );
    ok(await f.rigd(["install"]));
    ok(await f.rig(["init", "--create-git"]));
    ok(await f.rig(["up", "working"]));
    expect(await readFile(join(f.base, "first.caddy"), "utf8")).toContain(
      "header X-Probe first",
    );
    const reloads = async () =>
      (await readFile(evidence, "utf8")).trimEnd().split("\n");
    expect(new Set(await reloads())).toEqual(new Set(["first"]));

    // Edited while rigd runs: the next start of the Target publishes with the new settings, and rigd install has nothing
    // to restart for it.
    await configure("second");
    expect(ok(await f.rigd(["install"]))).toContain("unchanged");
    ok(await f.rig(["restart", "working"]));
    const second = await readFile(join(f.base, "second.caddy"), "utf8");
    expect(second).toContain("rig.528.test");
    expect(second).toContain("header X-Probe second");
    const switched = (await reloads()).indexOf("second");
    expect(switched).toBeGreaterThan(0);
    expect(new Set((await reloads()).slice(switched))).toEqual(
      new Set(["second"]),
    );
    ok(await f.rig(["down", "working"]));
  } finally {
    await f.cleanup();
    await rm(bin, { recursive: true, force: true });
  }
}, 120_000);
