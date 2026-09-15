import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRigRoot, verifyRigRoot } from "../src/cli/entry-environment";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("an unset or empty RIG_ROOT resolves to the home Rig root", () => {
  expect(resolveRigRoot(undefined, "/Users/someone")).toBe(
    "/Users/someone/.rig",
  );
  expect(resolveRigRoot("", "/Users/someone")).toBe("/Users/someone/.rig");
});
test("an absolute RIG_ROOT is used as given", () => {
  expect(resolveRigRoot("/tmp/rig-x/./root/", "/Users/someone")).toBe(
    "/tmp/rig-x/root",
  );
});
test("a relative RIG_ROOT is refused instead of resolving against the working directory", () => {
  expect(() => resolveRigRoot("state", "/Users/someone")).toThrow(
    expect.objectContaining({
      code: "USAGE",
      message: 'RIG_ROOT must be an absolute path, but it is "state".',
    }),
  );
});
for (const [entry, args] of [
  ["src/index.ts", ["list"]],
  ["src/rigd.ts", ["status"]],
] as const)
  test(`${entry} with a relative RIG_ROOT exits with a usage error and creates nothing`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rig-entry-"));
    roots.push(cwd);
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", entry), ...args],
      {
        cwd,
        env: { ...process.env, RIG_ROOT: "state" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain(
      'RIG_ROOT must be an absolute path, but it is "state".',
    );
    expect(stderr).toContain("absolute directory");
    expect(await readdir(cwd)).toEqual([]);
  });
test("a Rig root that is missing, or a directory the user can write, is accepted; a file or an unwritable directory is named", async () => {
  const base = await mkdtemp(join(tmpdir(), "rig-entry-"));
  roots.push(base);
  await expect(
    verifyRigRoot(join(base, "absent", "deeper")),
  ).resolves.toBeUndefined();
  await expect(verifyRigRoot(base)).resolves.toBeUndefined();
  await writeFile(join(base, "file"), "");
  await expect(verifyRigRoot(join(base, "file"))).rejects.toMatchObject({
    code: "RIG_ROOT",
    message: `The Rig root ${join(base, "file")} is not a directory.`,
    hint: "Set RIG_ROOT to a directory, or move that file aside.",
  });
  await expect(verifyRigRoot(join(base, "file", "sub"))).rejects.toMatchObject({
    code: "RIG_ROOT",
    message: `The Rig root ${join(base, "file", "sub")} cannot be created because ${join(base, "file")} is not a directory.`,
  });
  if (process.getuid?.() === 0) return;
  await chmod(base, 0o500);
  try {
    await expect(verifyRigRoot(base)).rejects.toMatchObject({
      code: "RIG_ROOT",
      message: `The Rig root ${base} is not writable.`,
      hint: `Fix its permissions (chmod u+rwx ${base}), or set RIG_ROOT to a writable directory.`,
    });
    await expect(verifyRigRoot(join(base, "absent"))).rejects.toMatchObject({
      code: "RIG_ROOT",
      message: `The Rig root ${join(base, "absent")} cannot be created because ${base} is not writable.`,
    });
  } finally {
    await chmod(base, 0o700);
  }
});
for (const [entry, args] of [
  ["src/index.ts", ["list"]],
  ["src/rigd.ts", ["status"]],
] as const)
  test(`${entry} with a RIG_ROOT that is a file or unwritable names the root and exits 1 without a diagnostic warning`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rig-entry-"));
    roots.push(cwd);
    const run = async (root: string) => {
      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dir, "..", entry), ...args],
        {
          cwd,
          env: { ...process.env, RIG_ROOT: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      return { code, stderr };
    };
    await writeFile(join(cwd, "file"), "");
    const file = await run(join(cwd, "file"));
    expect(file.code).toBe(1);
    expect(file.stderr).toBe(
      `The Rig root ${join(cwd, "file")} is not a directory.\nSet RIG_ROOT to a directory, or move that file aside.\n`,
    );
    if (process.getuid?.() === 0) return;
    await chmod(cwd, 0o500);
    try {
      const unwritable = await run(cwd);
      expect(unwritable.code).toBe(1);
      expect(unwritable.stderr).toBe(
        `The Rig root ${cwd} is not writable.\nFix its permissions (chmod u+rwx ${cwd}), or set RIG_ROOT to a writable directory.\n`,
      );
    } finally {
      await chmod(cwd, 0o700);
    }
    expect(await readdir(cwd)).toEqual(["file"]);
  });
test("rigd capture with a missing request file reports the failure in one line each for message and hint, and a bad arity is a usage error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rig-entry-"));
  roots.push(cwd);
  const rigd = async (...args: string[]) => {
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "src/rigd.ts"), ...args],
      {
        cwd,
        env: { ...process.env, RIG_ROOT: cwd },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    return { code, stderr };
  };
  const missing = await rigd("capture", join(cwd, "absent.json"));
  expect(missing.code).toBe(1);
  expect(missing.stderr).toBe(
    `The capture request ${join(cwd, "absent.json")} is missing or not a capture request (ENOENT).\nStart the Target again so rigd rewrites its capture request.\n`,
  );
  expect(await readdir(cwd)).toEqual([]);
  // Without its file the command is a person's mistake, so the documented CLI answers it.
  const arity = await rigd("capture");
  expect(arity.code).toBe(1);
  expect(arity.stderr).toBe(
    "missing required argument 'request-file'\nRun rigd capture --help.\n",
  );
});
