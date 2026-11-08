import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The real module, taken before it is mocked: the mock is process-wide, so every other use goes through to it. */
const real = { ...fs };
/** While set, the next `stat` of this path answers as the file was, then this runs before the answer is used. */
let afterStat: { path: string; run: () => Promise<void> } | undefined;
mock.module("node:fs/promises", () => ({
  ...real,
  async stat(path: string, ...rest: unknown[]) {
    const result = await (real.stat as (...args: unknown[]) => unknown)(
      path,
      ...rest,
    );
    const hook = afterStat;
    if (hook && path === hook.path) {
      afterStat = undefined;
      await hook.run();
    }
    return result;
  },
}));
const { editProjectConfig, readProjectConfig } =
  await import("../src/config/documents");
const { mkdtemp, readFile, realpath, rm, writeFile } = real;

test("rig.yaml changed by another editor while an edit is saved is left as that editor wrote it, with a hint to read it again", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-edit-race-"));
  try {
    const path = join(root, "rig.yaml");
    await writeFile(
      path,
      "name: pantry\nservices:\n  web:\n    command: serve\n",
    );
    const before = await readProjectConfig(root);
    const theirs = "name: pantry\nservices:\n  web:\n    command: theirs\n";
    // The edit has read the file and written its replacement; it stats the file for its mode just before checking again.
    afterStat = {
      path: await realpath(path),
      run: () => writeFile(path, theirs),
    };
    await expect(
      editProjectConfig({
        repoPath: root,
        expectedRevision: before.revision,
        edits: [{ path: ["services", "web", "command"], value: "mine" }],
      }),
    ).rejects.toMatchObject({
      _tag: "ConfigError",
      code: "revision_conflict",
      message: "Config changed during editing.",
      context: { path },
      hint: "Read the current config before retrying the edit.",
    });
    expect(afterStat).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(theirs);
  } finally {
    afterStat = undefined;
    await rm(root, { recursive: true, force: true });
  }
});
