import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The real module, taken before it is mocked: the mock is process-wide, so every other use goes through to it. */
const real = { ...fs };
/** While set, `link` runs this, then fails as a file system that refuses the link would. */
let beforeLinkFails: (() => Promise<void>) | undefined;
mock.module("node:fs/promises", () => ({
  ...real,
  async link(existing: string, created: string) {
    const failing = beforeLinkFails;
    if (!failing) return real.link(existing, created);
    beforeLinkFails = undefined;
    await failing();
    throw Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
  },
}));
const { dropCurrentFile } = await import("../src/providers/target-log");
const { mkdtemp, readFile, rm, stat, writeFile } = real;

test("a newer file whose restore fails is never put back over a file another writer started meanwhile", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-log-restore-"));
  try {
    const file = join(root, "target.jsonl");
    await writeFile(file, "full\n");
    const full = await stat(file);
    // A newer file replaced the full one before this holder got to drop it.
    await rm(file);
    await writeFile(file, "newer\n");
    beforeLinkFails = () => writeFile(file, "started meanwhile\n");
    await expect(
      dropCurrentFile(file, `${full.dev}-${full.ino}`),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(await readFile(file, "utf8")).toBe("started meanwhile\n");
    expect(await readFile(`${file}.1`, "utf8")).toBe("newer\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
