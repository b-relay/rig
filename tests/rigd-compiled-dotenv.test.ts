import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A compiled Bun executable loads .env files from its working directory unless it is built with
// --no-compile-autoload-dotenv. rigd runs as the capture wrapper (`rigd capture <request>`) in each Target's workspace,
// so without the flag a Project's .env reaches rigd's own environment: here it moves the Rig root, and the wrapper
// fails before it starts the Service.

let dist: string;
const build = async (output: string, flags: readonly string[]) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      ...flags,
      join(import.meta.dir, "../src/rigd.ts"),
      "--outfile",
      output,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code) throw new Error(`bun build --compile rigd failed: ${error}`);
};
beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "rig-compiled-dotenv-"));
  await Promise.all([
    build(join(dist, "rigd"), ["--no-compile-autoload-dotenv"]),
    build(join(dist, "rigd-autoload"), []),
  ]);
}, 120_000);
afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
});

test("the compiled rigd, which the build makes with --no-compile-autoload-dotenv, does not load a Target workspace's .env as the capture wrapper", async () => {
  const build = JSON.parse(
    await readFile(join(import.meta.dir, "../package.json"), "utf8"),
  ).scripts.build as string;
  expect(build).toMatch(
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
