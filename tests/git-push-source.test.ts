import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "../src/providers/command-runner";
import { createGitPushSource } from "../src/git/remote-helper";

const gitExecutable = "/Library/Developer/CommandLineTools/usr/bin/git";
test("a deployed Commit is rewritten when a local Branch of that name exists without it in its history", async () => {
  const repo = await realpath(
    await mkdtemp(join(tmpdir(), "rig-push-source-")),
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Rig Test",
    GIT_AUTHOR_EMAIL: "rig@example.invalid",
    GIT_COMMITTER_NAME: "Rig Test",
    GIT_COMMITTER_EMAIL: "rig@example.invalid",
  };
  const git = async (...args: string[]) => {
    const result = await runCommand({
      command: [gitExecutable, ...args],
      cwd: repo,
      env,
      timeoutMs: 20000,
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  };
  try {
    await git("init", "-b", "main");
    await writeFile(join(repo, "README.md"), "one\n");
    await git("add", "README.md");
    await git("commit", "-m", "one");
    const main = await git("rev-parse", "HEAD");
    await git("checkout", "-b", "c1");
    await writeFile(join(repo, "README.md"), "two\n");
    await git("commit", "-am", "two");
    const deployed = await git("rev-parse", "HEAD");
    const source = createGitPushSource(repo, (request) =>
      runCommand({ ...request, env }),
    );
    expect(await source.rewritten("c1", deployed)).toBe(false);
    expect(await source.rewritten("c1", main)).toBe(false);
    await git("checkout", "main");
    await git("branch", "-D", "c1");
    expect(await source.rewritten("c1", deployed)).toBe(false);
    await git("checkout", "-b", "c1", "main");
    expect(await source.rewritten("c1", deployed)).toBe(true);
    expect(await source.rewritten("c1", "f".repeat(40))).toBe(true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 20000);
