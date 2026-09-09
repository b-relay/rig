import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitSourceStore } from "../src/providers/git-source-store";
import { runCommand } from "../src/providers/command-runner";
const roots: string[] = [];
const gitExecutable = existsSync(
  "/Library/Developer/CommandLineTools/usr/bin/git",
)
  ? "/Library/Developer/CommandLineTools/usr/bin/git"
  : "git";
const gitRun: typeof runCommand = (request) =>
  runCommand({
    ...request,
    command:
      request.command[0] === "git"
        ? [gitExecutable, ...request.command.slice(1)]
        : request.command,
  });
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test.each([41, 63])("deployment rejects a %i-character Commit before publishing source files", async (length) => {
  const root = await mkdtemp(join(tmpdir(), "rig-git-invalid-"));
  roots.push(root);
  const sourceRoot = join(root, "sources");
  const store = createGitSourceStore({
    root: sourceRoot,
    run: async ({ command }) => {
      if (command[1] !== "rev-parse")
        throw new Error("Unexpected Git operation");
      return { exitCode: 0, stdout: "a".repeat(length), stderr: "" };
    },
  });
  await expect(
    store.prepare({
      project: "demo",
      repository: root,
      ref: "main",
      destination: join(root, "deployment"),
    }),
  ).rejects.toMatchObject({ code: "GIT_COMMIT" });
  expect(existsSync(sourceRoot)).toBe(false);
});
test("a committed deployment remains a complete Git workspace after its developer repository is deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-git-"));
  roots.push(root);
  const repository = join(root, "developer");
  await mkdir(repository);
  const git = async (...args: string[]) => {
    const result = await gitRun({ command: ["git", ...args], cwd: repository });
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  };
  await git("init", "-b", "main");
  await git("config", "user.email", "rig@example.invalid");
  await git("config", "user.name", "Rig Test");
  await writeFile(join(repository, "app.txt"), "committed content");
  await git("add", ".");
  await git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
  const expected = await git("rev-parse", "HEAD");
  const store = createGitSourceStore({
    root: join(root, "sources"),
    run: gitRun,
  });
  const destination = join(root, "deployments", "first");
  const prepared = await store.prepare({
    project: "stable-id",
    repository,
    ref: "main",
    destination,
  });
  expect(prepared.commit).toBe(expected);
  await rm(repository, { recursive: true, force: true });
  expect(await readFile(join(destination, "app.txt"), "utf8")).toBe(
    "committed content",
  );
  const fsck = await gitRun({
    command: ["git", "fsck", "--full"],
    cwd: destination,
  });
  expect(fsck.exitCode).toBe(0);
  expect(
    (
      await gitRun({ command: ["git", "rev-parse", "HEAD"], cwd: destination })
    ).stdout.trim(),
  ).toBe(expected);
});
test("a borrowed source clone does not leave deployment Git objects dependent on the donor", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-git-alternates-"));
  roots.push(root);
  const donor = join(root, "donor");
  const borrower = join(root, "borrower");
  await mkdir(donor);
  const git = async (...args: string[]) => {
    const result = await gitRun({ command: ["git", ...args], cwd: donor });
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  };
  await git("init", "-b", "main");
  await git("config", "user.email", "rig@example.invalid");
  await git("config", "user.name", "Rig Test");
  await writeFile(join(donor, "app.txt"), "owned content");
  await git("add", ".");
  await git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
  await git("clone", "--shared", donor, borrower);
  const store = createGitSourceStore({
    root: join(root, "sources"),
    run: gitRun,
  });
  const prepared = await store.prepare({
    project: "borrowed",
    repository: borrower,
    ref: "main",
    destination: join(root, "deployment"),
  });
  await rm(donor, { recursive: true, force: true });
  await rm(borrower, { recursive: true, force: true });
  expect(
    (
      await gitRun({
        command: ["git", "fsck", "--full"],
        cwd: prepared.workspacePath,
      })
    ).exitCode,
  ).toBe(0);
});
