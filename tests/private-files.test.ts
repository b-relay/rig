import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPrivateFile,
  openPrivateFile,
  privateDirectory,
  readPrivateFile,
  replacePrivateFile,
} from "../src/providers/private-files";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
/** A Rig root and, beside it, a directory standing for everything outside it. */
async function layout() {
  const base = await mkdtemp(join(tmpdir(), "rig-private-files-"));
  roots.push(base);
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root, { mode: 0o700 });
  await mkdir(outside);
  await writeFile(join(outside, "target"), "outside\n", { mode: 0o644 });
  return { root, outside, target: join(outside, "target") };
}
const mode = async (path: string) => (await lstat(path)).mode & 0o777;
async function withUmask<T>(mask: number, run: () => Promise<T>): Promise<T> {
  const previous = process.umask(mask);
  try {
    return await run();
  } finally {
    process.umask(previous);
  }
}

test("a replacement renames a new private file over a link at the destination, and what the link led to is untouched", async () => {
  const { root, target } = await layout();
  const path = join(root, "auth", "control-plane.token");
  await mkdir(join(root, "auth"), { mode: 0o700 });
  await symlink(target, path);
  await replacePrivateFile(root, path, "secret");
  expect((await lstat(path)).isFile()).toBe(true);
  expect(await readFile(path, "utf8")).toBe("secret");
  expect(await mode(path)).toBe(0o600);
  expect(await readFile(target, "utf8")).toBe("outside\n");
  expect(await mode(target)).toBe(0o644);
});

test("a replacement sets the mode it is asked for and makes missing directories 0700, whatever the umask", async () => {
  const { root } = await layout();
  await withUmask(0o002, async () => {
    await replacePrivateFile(root, join(root, "a", "b", "record.json"), "{}");
    await replacePrivateFile(root, join(root, "bin", "tool"), "#!/bin/sh\n", {
      mode: 0o755,
    });
  });
  await withUmask(0o077, () =>
    replacePrivateFile(root, join(root, "daemon", "job.plist"), "<plist/>", {
      mode: 0o644,
    }),
  );
  expect(await mode(join(root, "a"))).toBe(0o700);
  expect(await mode(join(root, "a", "b"))).toBe(0o700);
  expect(await mode(join(root, "a", "b", "record.json"))).toBe(0o600);
  expect(await mode(join(root, "bin", "tool"))).toBe(0o755);
  expect(await mode(join(root, "daemon", "job.plist"))).toBe(0o644);
});

test("a replacement abandoned before its rename leaves the old contents and no temporary file", async () => {
  const { root } = await layout();
  const path = join(root, "runtime", "state.json");
  await replacePrivateFile(root, path, "old");
  await expect(
    replacePrivateFile(root, path, "new", {
      durable: true,
      confirm: async () => {
        throw new Error("changed meanwhile");
      },
    }),
  ).rejects.toThrow("changed meanwhile");
  expect(await readFile(path, "utf8")).toBe("old");
  expect(await readdir(join(root, "runtime"))).toEqual(["state.json"]);
});

test("concurrent replacements use their own temporary files: the result is one whole document and nothing is left beside it", async () => {
  const { root } = await layout();
  const path = join(root, "process-leases", "lease.json");
  const documents = Array.from({ length: 20 }, (_, n) =>
    JSON.stringify({ n, pad: "x".repeat(64 * 1024) }),
  );
  await Promise.all(
    documents.map((document) => replacePrivateFile(root, path, document)),
  );
  expect(documents).toContain(await readFile(path, "utf8"));
  expect(await readdir(join(root, "process-leases"))).toEqual(["lease.json"]);
});

test("a directory on the way that is a link, a file, or writable by others is refused by name, and nothing is written through it", async () => {
  const { root, outside } = await layout();
  await symlink(outside, join(root, "runtime"));
  await expect(
    replacePrivateFile(root, join(root, "runtime", "state.json"), "{}"),
  ).rejects.toMatchObject({
    code: "RIG_ROOT_UNSAFE",
    details: { path: join(root, "runtime"), problem: "is a symbolic link" },
  });
  await expect(
    appendPrivateFile(root, join(root, "runtime", "log.jsonl"), "{}\n"),
  ).rejects.toMatchObject({ code: "RIG_ROOT_UNSAFE" });
  expect((await readdir(outside)).sort()).toEqual(["target"]);

  await writeFile(join(root, "logs"), "a file");
  await expect(
    privateDirectory(root, join(root, "logs", "rigd")),
  ).rejects.toMatchObject({
    code: "RIG_ROOT_UNSAFE",
    details: { path: join(root, "logs") },
  });

  await mkdir(join(root, "capture"));
  await chmod(join(root, "capture"), 0o775);
  const refused = await privateDirectory(root, join(root, "capture")).catch(
    (error) => error,
  );
  expect(refused).toMatchObject({
    code: "RIG_ROOT_UNSAFE",
    details: { problem: "can be written by other users" },
  });
  expect(refused.hint).toContain(`chmod 700 ${join(root, "capture")}`);
  expect(await mode(join(root, "capture"))).toBe(0o775);
});

test("a directory only others can read is made the owner's alone; what the owner may do is kept", async () => {
  const { root } = await layout();
  await chmod(root, 0o755);
  await mkdir(join(root, "daemon"), { mode: 0o755 });
  await chmod(join(root, "daemon"), 0o755);
  await mkdir(join(root, "auth"));
  await chmod(join(root, "auth"), 0o500);
  await privateDirectory(root, join(root, "daemon"));
  await privateDirectory(root, join(root, "auth"));
  expect(await mode(root)).toBe(0o700);
  expect(await mode(join(root, "daemon"))).toBe(0o700);
  expect(await mode(join(root, "auth"))).toBe(0o500);
  await chmod(join(root, "auth"), 0o700);
});

test("a path outside the root is never written", async () => {
  const { root, outside } = await layout();
  await expect(
    replacePrivateFile(root, join(outside, "record.json"), "{}"),
  ).rejects.toMatchObject({ code: "RIG_ROOT_PATH" });
  await expect(
    replacePrivateFile(root, join(root, "..", "outside", "x"), "{}"),
  ).rejects.toMatchObject({ code: "RIG_ROOT_PATH" });
  expect(await readdir(outside)).toEqual(["target"]);
});

test("an append refuses a link at the file, and a create refuses anything already there", async () => {
  const { root, target } = await layout();
  const log = join(root, "daemon", "startup.log");
  await mkdir(join(root, "daemon"), { mode: 0o700 });
  await symlink(target, log);
  await expect(appendPrivateFile(root, log, "line\n")).rejects.toMatchObject({
    code: "RIG_ROOT_UNSAFE",
  });
  await expect(openPrivateFile(root, log, "create")).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(target, "utf8")).toBe("outside\n");
  const fresh = join(root, "daemon", "rigd.log");
  await withUmask(0o002, () => appendPrivateFile(root, fresh, "one\n"));
  await appendPrivateFile(root, fresh, "two\n");
  expect(await readFile(fresh, "utf8")).toBe("one\ntwo\n");
  expect(await mode(fresh)).toBe(0o600);
});

test("a private read takes only a regular file the user alone can write, in directories the user alone can write", async () => {
  const { root, target } = await layout();
  const directory = join(root, "capture");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "request.json");
  await writeFile(path, "{}", { mode: 0o600 });
  expect(await readPrivateFile(root, path)).toBe("{}");

  await chmod(path, 0o620);
  await expect(readPrivateFile(root, path)).rejects.toMatchObject({
    code: "RIG_FILE_UNTRUSTED",
    details: { problem: "can be written by other users" },
  });
  await rm(path);
  await symlink(target, path);
  await expect(readPrivateFile(root, path)).rejects.toMatchObject({
    code: "RIG_FILE_UNTRUSTED",
    details: { problem: "is a symbolic link" },
  });
  await rm(path);
  await mkdir(path);
  await expect(readPrivateFile(root, path)).rejects.toMatchObject({
    code: "RIG_FILE_UNTRUSTED",
  });
  await rm(path, { recursive: true });
  await writeFile(path, "{}", { mode: 0o600 });
  await chmod(directory, 0o770);
  await expect(readPrivateFile(root, path)).rejects.toMatchObject({
    code: "RIG_ROOT_UNSAFE",
  });
  // A read changes nothing, not even a mode it refuses.
  expect((await stat(directory)).mode & 0o777).toBe(0o770);
  await expect(
    readPrivateFile(root, join(root, "missing", "x")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
