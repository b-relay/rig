import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

// #267: a compiled rigd's process.execPath is rigd itself, so a Tool whose bin is a source
// file must be shimmed to the bun recorded at rigd install, never to the running executable.

type Fixture = Awaited<ReturnType<typeof rigFixture>>;
let dist: string;
const bunDirectory = dirname(process.execPath);

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "rig-compiled-tools-"));
  await Promise.all(
    (["index", "rigd"] as const).map(async (entry) => {
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "--compile",
          join(import.meta.dir, `../src/${entry}.ts`),
          "--outfile",
          join(dist, entry === "index" ? "rig" : "rigd"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, error] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      if (code)
        throw new Error(`bun build --compile ${entry} failed: ${error}`);
    }),
  );
}, 120000);
afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
});

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
  expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
  expect(await f.rig(["init"])).toMatchObject({ code: 0 });
}

test("with the compiled rigd, a Tool whose bin is a .ts file runs with the bun on the installing shell's PATH, keeps relative imports, and passes its arguments through", async () => {
  const f = await compiled(`${bunDirectory}:/usr/bin:/bin`);
  try {
    await project(f);
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
    await project(f);
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
