import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startControlPlane } from "../src/daemon/server";
import { runCommand } from "../src/providers/command-runner";
import type { RuntimeCommand } from "../src/daemon/protocol";

const gitExecutable = "/Library/Developer/CommandLineTools/usr/bin/git";
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
test("real git push invokes the helper and sends an authenticated exact Commit to its destination Branch", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "rig-git-push-")),
  );
  const root = join(directory, "state"),
    repo = join(directory, "repo"),
    bin = join(directory, "bin");
  const requests: RuntimeCommand[] = [];
  let invalidStatus = false;
  let server: ReturnType<typeof startControlPlane> | undefined;
  const env = {
    ...process.env,
    PATH: `${bin}:/Library/Developer/CommandLineTools/usr/bin:${process.env.PATH}`,
    RIG_ROOT: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Rig Test",
    GIT_AUTHOR_EMAIL: "rig@example.invalid",
    GIT_COMMITTER_NAME: "Rig Test",
    GIT_COMMITTER_EMAIL: "rig@example.invalid",
  };
  const git = async (args: string[], cwd = repo) =>
    await runCommand({
      command: [gitExecutable, ...args],
      cwd,
      env,
      timeoutMs: 20000,
    });
  try {
    server = startControlPlane({
      port: 0,
      token: "isolated-test-token",
      instanceId: "git-test",
      async handle(command) {
        requests.push(command);
        return command.action === "status"
          ? invalidStatus
            ? { project: "example" }
            : { project: "example", targets: [] }
          : { outcome: "deployed" };
      },
    });
    await mkdir(repo, { recursive: true });
    await mkdir(bin);
    await mkdir(join(root, "auth"), { recursive: true });
    await mkdir(join(root, "daemon"));
    await writeFile(
      join(root, "auth", "control-plane.token"),
      "isolated-test-token",
    );
    await writeFile(
      join(root, "daemon", "address.json"),
      JSON.stringify({
        port: server.port,
        pid: process.pid,
        instanceId: "git-test",
      }),
    );
    await writeFile(
      join(bin, "git-remote-rig"),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve("src/git/remote-helper.ts"))} "$@"\n`,
    );
    await chmod(join(bin, "git-remote-rig"), 0o755);
    expect((await git(["init", "-b", "main"])).exitCode).toBe(0);
    await writeFile(join(repo, "README.md"), "exact source\n");
    expect((await git(["add", "README.md"])).exitCode).toBe(0);
    expect((await git(["commit", "-m", "test: initial"])).exitCode).toBe(0);
    const expectedCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    expect(
      (await git(["remote", "add", "rig", "rig://localhost/example"])).exitCode,
    ).toBe(0);
    const pushed = await git(["push", "rig", "main:preview/main"]);
    expect(pushed.stderr).not.toContain("fatal:");
    expect(pushed.exitCode).toBe(0);
    expect(
      requests.find((request) => request.action === "git-push"),
    ).toMatchObject({
      project: "example",
      repoPath: repo,
      branch: "preview/main",
      commit: expectedCommit,
    });
    const dryRun = await git(["push", "--dry-run", "rig", "main"]);
    expect(dryRun.exitCode).toBe(0);
    expect(
      requests.filter((request) => request.action === "git-push"),
    ).toHaveLength(1);
    expect(await readFile(join(root, "logs/rig/rig.jsonl"), "utf8")).toContain(
      "git-push",
    );
    // A linked worktree shares the repository, so a push from it names the registered main working tree.
    const linked = join(directory, "wt");
    expect(
      (await git(["worktree", "add", "-b", "feature", linked])).exitCode,
    ).toBe(0);
    await writeFile(join(linked, "README.md"), "from the worktree\n");
    expect(
      (await git(["commit", "-am", "feat: worktree"], linked)).exitCode,
    ).toBe(0);
    const featureCommit = (
      await git(["rev-parse", "HEAD"], linked)
    ).stdout.trim();
    const fromWorktree = await git(["push", "rig", "feature"], linked);
    expect(fromWorktree.stderr).not.toContain("fatal:");
    expect(fromWorktree.exitCode).toBe(0);
    expect(
      requests.filter((r) => r.action === "git-push").at(-1),
    ).toMatchObject({
      project: "example",
      repoPath: repo,
      branch: "feature",
      commit: featureCommit,
    });
    // A tag in the batch is rejected per ref; the helper must answer git instead of hanging.
    expect((await git(["tag", "v1"])).exitCode).toBe(0);
    const tagged = await git(["push", "rig", "main:preview/main", "v1"]);
    expect(tagged.exitCode).not.toBe(0);
    expect(tagged.stderr).toContain("[remote rejected]");
    expect(tagged.stderr).toContain("tags are not pushed");
    expect(tagged.stderr).not.toContain("preview/main -> preview/main (Rig");
    // A fatal helper error (rigd answering status with an invalid reply) must end the conversation, not hang git.
    invalidStatus = true;
    const fatal = await git(["push", "rig", "main"]);
    expect(fatal.exitCode).not.toBe(0);
    expect(fatal.stderr).toContain("invalid response");
  } finally {
    await server?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
