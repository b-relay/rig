import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRigRoot } from "../src/cli/entry-environment";
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
test("rigd capture with a missing request file reports the failure in one line each for message and hint, and a bad arity prints usage", async () => {
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
  const arity = await rigd("capture");
  expect(arity.code).toBe(2);
  expect(arity.stderr).toBe("Usage: rigd capture <request-file>\n");
  expect(await readdir(cwd)).toEqual([]);
});
