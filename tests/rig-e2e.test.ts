import { test, expect } from "bun:test";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const rig = join(import.meta.dir, "../src/index.ts"),
  rigd = join(import.meta.dir, "../src/rigd.ts");
test("real daemon owns working-copy process across CLI clients and releases its port on down", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rig-e2e-")),
    root = join(directory, ".rig"),
    repo = join(directory, "project");
  await mkdir(repo);
  const env = { ...process.env, RIG_ROOT: root };
  const call = async (entry: string, args: string[], cwd = repo) => {
    const process = Bun.spawn([Bun.which("bun")!, entry, ...args], {
      env,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    await writeFile(
      join(repo, "server.ts"),
      `const s=Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response(process.cwd())});process.stdout.write('hello stdout\\n');process.stderr.write('hello stderr\\n');`,
    );
    await writeFile(
      join(repo, "rig.json"),
      JSON.stringify({
        name: "demo",
        hooks: { preStart: "printf 'setup production stdout\\n'; printf 'setup production stderr\\n' >&2" },
        components: {
          web: {
            mode: "managed",
            command: `'${process.execPath}' server.ts`,
            health: "http://127.0.0.1:${web.port}",
            env: { PORT: "${web.port}" },
          },
        },
      }),
    );
    expect(await call(rigd, ["install"])).toMatchObject({ code: 0 });
    expect(await call(rig, ["init", "--create-git"])).toMatchObject({
      code: 0,
    });
    const up = await call(rig, ["up", "local", "--json"]);
    expect(up).toMatchObject({ code: 0 });
    expect(JSON.parse(up.stdout)).toMatchObject({
      outcome: "started",
      project: "demo",
    });
    const status = await call(rig, ["status", "--json"]);
    expect(status.code).toBe(0);
    const target = JSON.parse(status.stdout).targets[0];
    expect(target).toMatchObject({
      state: "healthy",
      components: [{ name: "web", state: "healthy" }],
    });
    const port = target.components[0].port;
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
      await realpath(repo),
    );
    const repeat = await call(rig, ["up", "local", "--json"]);
    expect(JSON.parse(repeat.stdout).outcome).toBe("unchanged");
    const logs = await call(rig, ["logs", "local"]);
    expect(logs.stdout).toContain("hello stdout");
    expect(logs.stdout).toContain("hello stderr");
    expect(logs.stdout).toMatch(/\d{2}:\d{2}:\d{2}  setup  > setup production stdout/);
    expect(logs.stdout).toContain("setup  ! setup production stderr");
    expect(await call(rigd, ["uninstall"])).toMatchObject({ code: 1 });
    expect(
      await call(rig, ["down", "local", "--json"], directory),
    ).toMatchObject({ code: 1 });
    const down = await call(
      rig,
      ["down", "local", "--project", "demo", "--json"],
      directory,
    );
    expect(down).toMatchObject({ code: 0 });
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    const after = await call(
      rig,
      ["status", "--project", "demo", "--json"],
      directory,
    );
    expect(JSON.parse(after.stdout).targets[0].state).toBe("stopped");
    expect(await call(rigd, ["uninstall"])).toMatchObject({ code: 0 });
    expect(
      JSON.parse(await readFile(join(root, "runtime", "state.json"), "utf8"))
        .targets,
    ).toHaveLength(1);
  } finally {
    await call(rig, ["down", "local", "--project", "demo"]).catch(() => {});
    await call(rigd, ["uninstall"]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
