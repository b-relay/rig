import { test, expect } from "bun:test";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const toolPrint = (text: string) => `console.log(${JSON.stringify(text)});\n`;

test.each([
  ["stable", ["stable"], ["stable"]],
  ["preview", ["preview", "feature"], ["preview", "feature"]],
] as const)(
  "after deploy --no-up a published source-file Tool of a %s Target still runs, and its checkout goes only once rig up replaces it",
  async (kind, deploy, select) => {
    const f = await rigFixture();
    try {
      await f.git(["init", "-b", "main"]);
      await writeFile(
        join(f.repo, "rig.yaml"),
        "name: demo\ntargets: { stable: true, preview: true }\ntools:\n  cli:\n    bin: cli.ts\n",
      );
      await writeFile(join(f.repo, "cli.ts"), toolPrint("first"));
      await f.commit();
      expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
      expect(await f.rig(["init"])).toMatchObject({ code: 0 });
      if (kind === "preview") await f.git(["checkout", "-b", "feature"]);
      expect(await f.rig(["deploy", ...deploy])).toMatchObject({ code: 0 });

      const recorded = async () =>
        JSON.parse(
          await readFile(join(f.root, "runtime", "state.json"), "utf8"),
        )
          .targets.filter((t: { kind: string }) => t.kind === kind)
          .at(0) as { name: string; plan: { workspacePath: string } };
      const first = await recorded();
      const tool = join(
        f.root,
        "bin",
        kind === "stable" ? "cli" : `cli-${first.name}`,
      );
      const prints = async () => {
        const run = await f.run([tool]);
        expect(run).toMatchObject({ code: 0 });
        return run.stdout.trim();
      };
      expect(await prints()).toBe("first");

      await writeFile(join(f.repo, "cli.ts"), toolPrint("second"));
      await f.commit();
      expect(await f.rig(["deploy", ...deploy, "--no-up"])).toMatchObject({
        code: 0,
      });
      const second = await recorded();
      expect(second.plan.workspacePath).not.toBe(first.plan.workspacePath);
      expect(await prints()).toBe("first");
      expect(await exists(first.plan.workspacePath)).toBe(true);

      // A checkout no Tool was ever published from goes as before, whichever one the Tool still needs.
      await writeFile(join(f.repo, "cli.ts"), toolPrint("third"));
      await f.commit();
      expect(await f.rig(["deploy", ...deploy, "--no-up"])).toMatchObject({
        code: 0,
      });
      const third = await recorded();
      expect(await exists(second.plan.workspacePath)).toBe(false);
      expect(await prints()).toBe("first");
      expect(await exists(first.plan.workspacePath)).toBe(true);

      expect(await f.rig(["up", ...select])).toMatchObject({ code: 0 });
      expect(await prints()).toBe("third");
      expect(await exists(first.plan.workspacePath)).toBe(false);
      expect(await exists(third.plan.workspacePath)).toBe(true);
      expect(await f.rig(["down", ...select])).toMatchObject({ code: 0 });
    } finally {
      await f.cleanup();
    }
  },
  90_000,
);

test("deploy --no-up keeps no checkout for a copied Tool, which needs none, nor for a source-file Tool the new Commit drops, which it retires", async () => {
  const f = await rigFixture();
  try {
    await f.git(["init", "-b", "main"]);
    const config = (tools: string) =>
      `name: demo\ntargets: { stable: true }\ntools:\n${tools}`;
    const copied = "  copied:\n    bin: copied.sh\n";
    await writeFile(
      join(f.repo, "rig.yaml"),
      config(`${copied}  dropped:\n    bin: dropped.ts\n`),
    );
    await writeFile(join(f.repo, "copied.sh"), "#!/bin/sh\necho copied\n", {
      mode: 0o755,
    });
    await writeFile(join(f.repo, "dropped.ts"), toolPrint("dropped"));
    await f.commit();
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    expect(await f.rig(["deploy", "stable"])).toMatchObject({ code: 0 });
    const checkout = async () =>
      (
        JSON.parse(
          await readFile(join(f.root, "runtime", "state.json"), "utf8"),
        ).targets.find((t: { kind: string }) => t.kind === "stable") as {
          plan: { workspacePath: string };
        }
      ).plan.workspacePath;
    const first = await checkout();

    await writeFile(join(f.repo, "rig.yaml"), config(copied));
    await f.commit();
    expect(await f.rig(["deploy", "stable", "--no-up"])).toMatchObject({
      code: 0,
    });
    expect(await exists(join(f.root, "bin", "dropped"))).toBe(false);
    expect(await exists(first)).toBe(false);
    expect((await f.run([join(f.root, "bin", "copied")])).stdout.trim()).toBe(
      "copied",
    );
  } finally {
    await f.cleanup();
  }
}, 60_000);

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
    const deployed = await f.rig(["deploy", "stable"]);
    expect(deployed).toMatchObject({ code: 0 });
    expect(deployed.stdout).toContain(
      `demo stable deployed main@${commit.slice(0, 7)}`,
    );
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
    const replacement = await f.rig(["deploy", "stable"]);
    expect(replacement).toMatchObject({ code: 0 });
    const replaced = JSON.parse(
      await readFile(join(f.root, "runtime", "state.json"), "utf8"),
    ).targets[0];
    expect(
      replaced.plan.components.find((c: any) => c.name === "web").port,
    ).toBe(target.plan.components.find((c: any) => c.name === "web").port);
    expect(await f.rig(["down", "stable"])).toMatchObject({
      code: 0,
    });
    const noop = await f.rig(["deploy", "stable"]);
    expect(noop.stdout).toContain("demo stable unchanged");
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
    expect(await f.rig(["up", "stable"])).toMatchObject({ code: 0 });
    const after = JSON.parse(
      (await f.rig(["status", "--json"])).stdout,
    ).targets.find((t: any) => t.name === "stable");
    expect(after).toMatchObject({ branch: "main", commit, state: "healthy" });
    expect(await readFile(persistent, "utf8")).toBe("precious database bytes");
    await rename(f.repo, `${f.repo}-moved`);
    expect(
      await f.rig(["down", "stable", "--project", "demo"], f.base),
    ).toMatchObject({ code: 0 });
    expect(
      await f.rig(["up", "stable", "--project", "demo"], f.base),
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
