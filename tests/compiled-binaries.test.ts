import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

// The compiled rig and rigd, built once for every test here. rigd is built with the flag the release build gives it;
// rigd-autoload without it, to show what the flag prevents.

type Fixture = Awaited<ReturnType<typeof rigFixture>>;
let dist: string;
const bunDirectory = dirname(process.execPath);
const build = async (
  entry: "index" | "rigd",
  output: string,
  flags: readonly string[] = [],
) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      ...flags,
      join(import.meta.dir, `../src/${entry}.ts`),
      "--outfile",
      join(dist, output),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code) throw new Error(`bun build --compile ${output} failed: ${error}`);
};

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "rig-compiled-"));
  await Promise.all([
    build("index", "rig"),
    build("rigd", "rigd", ["--no-compile-autoload-dotenv"]),
    build("rigd", "rigd-autoload"),
  ]);
}, 120000);
afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
});

// #267: a compiled rigd's process.execPath is rigd itself, so a Tool whose bin is a source
// file must be shimmed to the bun recorded at rigd install, never to the running executable.
const compiled = (PATH: string) =>
  rigFixture({
    commands: { rig: [join(dist, "rig")], rigd: [join(dist, "rigd")] },
    PATH,
  });
async function project(f: Fixture) {
  await f.git(["init", "-b", "main"]);
  await writeFile(
    join(f.repo, "value.ts"),
    'export const value = "imported-ok";\n',
  );
  await writeFile(
    join(f.repo, "tool.ts"),
    'import { value } from "./value";\nprocess.stdout.write(`hello from tool.ts: ${value} ${process.argv.slice(2).join(" ")}\\n`);\n',
  );
  await writeFile(
    join(f.repo, "rig.yaml"),
    "name: compiledtools\ntools:\n  hello-ts:\n    bin: tool.ts\n",
  );
  await f.commit();
  const install = await f.rigd(["install"]);
  expect(install).toMatchObject({ code: 0 });
  expect(await f.rig(["init"])).toMatchObject({ code: 0 });
  return install.stdout + install.stderr;
}

test("with the compiled rigd, a Tool whose bin is a .ts file runs with the bun on the installing shell's PATH, keeps relative imports, and passes its arguments through", async () => {
  const f = await compiled(`${bunDirectory}:/usr/bin:/bin`);
  try {
    expect(await project(f)).not.toContain("BUN_NOT_FOUND");
    expect(await f.rig(["up", "local"])).toMatchObject({ code: 0 });
    expect(await f.rig(["deploy", "live"])).toMatchObject({ code: 0 });
    for (const name of ["hello-ts-local", "hello-ts"]) {
      const published = join(f.root, "bin", name);
      const shim = await readFile(published, "utf8");
      expect(shim).toStartWith(
        `#!/bin/sh\nexec '${join(bunDirectory, "bun")}' '`,
      );
      expect(shim).not.toContain(dist);
      expect(await f.run([published, "a", "b c"], f.base)).toEqual({
        code: 0,
        stdout: "hello from tool.ts: imported-ok a b c\n",
        stderr: "",
      });
    }
    for (const target of ["local", "live"])
      expect((await f.rig(["down", target])).code).toBe(0);
  } finally {
    await f.cleanup();
  }
}, 120000);

test("with the compiled rigd and no bun on the installing shell's PATH, installing a .ts Tool fails as BUN_NOT_FOUND and publishes nothing", async () => {
  const f = await compiled("/usr/bin:/bin");
  try {
    // The install itself succeeds, since built Tools and Services need no bun, but says what will fail.
    expect(await project(f)).toContain("Warning: rigd install found no bun");
    const up = await f.rig(["up", "local", "--json"]);
    expect(up.code).toBe(1);
    expect(up.stdout + up.stderr).toContain("BUN_NOT_FOUND");
    expect(up.stdout + up.stderr).toContain("rigd install");
    expect(await readdir(join(f.root, "bin")).catch(() => [])).toEqual([]);
    await f.rig(["down", "local"]);
  } finally {
    await f.cleanup();
  }
}, 120000);

// A compiled Bun executable loads .env files from its working directory unless it is built with
// --no-compile-autoload-dotenv. rigd runs as the capture wrapper (`rigd capture <request>`) in each Target's workspace,
// so without the flag a Project's .env reaches rigd's own environment: here it moves the Rig root, and the wrapper
// fails before it starts the Service.
test("the compiled rigd, which the build makes with --no-compile-autoload-dotenv, does not load a Target workspace's .env as the capture wrapper", async () => {
  const release = JSON.parse(
    await readFile(join(import.meta.dir, "../package.json"), "utf8"),
  ).scripts.build as string;
  expect(release).toMatch(
    /--no-compile-autoload-dotenv [^&]*src\/rigd\.ts --outfile rigd/,
  );
  const workspace = join(dist, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, ".env"), "RIG_ROOT=relative/root\n");
  const capture = async (rigd: string) => {
    const child = Bun.spawn([rigd, "capture", join(dist, "missing.json")], {
      cwd: workspace,
      // A temporary HOME: the Rig root rigd would use is under it, never the real ~/.rig.
      env: { HOME: join(dist, "home"), PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    return await new Response(child.stderr).text();
  };
  const leak = "RIG_ROOT must be an absolute path";
  // Without the flag, the workspace's .env decides rigd's Rig root.
  expect(await capture(join(dist, "rigd-autoload"))).toContain(leak);
  // With it, the wrapper gets as far as its (missing) request file.
  expect(await capture(join(dist, "rigd"))).not.toContain(leak);
}, 60_000);
