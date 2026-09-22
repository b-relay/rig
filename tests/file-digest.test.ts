import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDigest, rememberedDigests } from "../src/adapters/file-digest";

const scratch = async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-digest-"));
  return { root, done: () => rm(root, { recursive: true, force: true }) };
};

test("a remembered digest hashes an unchanged file once", async () => {
  const { root, done } = await scratch();
  try {
    const path = join(root, "tool");
    await writeFile(path, "one");
    let reads = 0;
    const digest = rememberedDigests(async (each) => {
      reads++;
      return fileDigest(each);
    });
    const first = await digest(path);
    expect(first).toBe(await fileDigest(path));
    expect(await digest(path)).toBe(first);
    expect(reads).toBe(1);
  } finally {
    await done();
  }
});

test("a file replaced by rename or touched is hashed again", async () => {
  const { root, done } = await scratch();
  try {
    const path = join(root, "tool");
    await writeFile(path, "one");
    const digest = rememberedDigests();
    const first = await digest(path);
    // Installation publishes by atomic rename: a new inode with the same size.
    await writeFile(path + ".tmp", "two");
    await rename(path + ".tmp", path);
    const second = await digest(path);
    expect(second).not.toBe(first);
    expect(second).toBe(await fileDigest(path));
    // An in-place edit that keeps the size still changes the modification time.
    await writeFile(path, "six");
    await utimes(path, new Date(), new Date(Date.now() + 5_000));
    expect(await digest(path)).toBe(await fileDigest(path));
    // An edit that puts the modification time back still moves the inode change time.
    const { mtime } = await stat(path);
    await writeFile(path, "ten");
    await utimes(path, mtime, mtime);
    expect(await digest(path)).toBe(await fileDigest(path));
  } finally {
    await done();
  }
});

test("a file rewritten while it was being hashed is not remembered", async () => {
  const { root, done } = await scratch();
  try {
    const path = join(root, "tool");
    await writeFile(path, "one");
    let reads = 0;
    const digest = rememberedDigests(async (each) => {
      reads++;
      const answer = await fileDigest(each);
      if (reads === 1) await writeFile(each, "two");
      return answer;
    });
    expect(await digest(path)).toBe(
      createHash("sha256").update("one").digest("hex"),
    );
    expect(await digest(path)).toBe(await fileDigest(path));
    expect(reads).toBe(2);
  } finally {
    await done();
  }
});

test("a missing file answers undefined and forgets what it knew", async () => {
  const { root, done } = await scratch();
  try {
    const path = join(root, "tool");
    await writeFile(path, "one");
    const digest = rememberedDigests();
    const first = await digest(path);
    await rm(path);
    expect(await digest(path)).toBeUndefined();
    await writeFile(path, "one");
    expect(await digest(path)).toBe(first);
    await expect(digest(root)).rejects.toMatchObject({ code: "ARTIFACT_TYPE" });
  } finally {
    await done();
  }
});
