import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
export async function rigFixture() {
  const base = await mkdtemp(join(tmpdir(), "rig-battle-")),
    root = join(base, ".rig"),
    repo = join(base, "project");
  await mkdir(repo);
  const environment = { ...process.env, RIG_ROOT: root };
  const run = async (args: string[], cwd = repo) => {
    const child = Bun.spawn(args, {
      cwd,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const rig = (args: string[], cwd = repo) =>
    run(
      [process.execPath, join(import.meta.dir, "../../src/index.ts"), ...args],
      cwd,
    );
  const rigd = (args: string[]) =>
    run(
      [process.execPath, join(import.meta.dir, "../../src/rigd.ts"), ...args],
      base,
    );
  const git = async (args: string[]) => {
    const result = await run(["git", ...args]);
    if (result.code) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = async () => {
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Rig Test",
      "-c",
      "user.email=rig-test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    return await git(["rev-parse", "HEAD"]);
  };
  const cleanup = async () => {
    // Tests explicitly stop their recorded Targets; cleanup still stops local/live if a failed assertion left them running.
    for (const target of ["local", "live"])
      await rig(["down", target, "--project", "demo"], base).catch(() => {});
    await rigd(["uninstall"]).catch(() => {});
    await rm(base, { recursive: true, force: true });
  };
  return {
    base,
    root,
    repo,
    run,
    rig,
    rigd,
    git,
    commit,
    cleanup,
    canonicalRepo: await realpath(repo),
  };
}
