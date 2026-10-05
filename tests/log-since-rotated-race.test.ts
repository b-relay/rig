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
const { createRuntimeFiles } = await import("../src/adapters/runtime-files");
const { mkdir, mkdtemp, rm, utimes, writeFile, appendFile } = real;

const record = (line: string, at: Date) =>
  JSON.stringify({
    timestamp: at.toISOString(),
    component: "web",
    stream: "stdout",
    line,
  }) + "\n";

test("a line appended to the generation rotated last between its time check and its position is read, not skipped", async () => {
  const base = await mkdtemp(join(tmpdir(), "rig-since-race-"));
  try {
    const logRoot = join(base, "logs");
    await mkdir(logRoot);
    const path = join(logRoot, "target.jsonl");
    const now = Date.now();
    const old = new Date(now - 3 * 3600_000);
    await writeFile(`${path}.1`, record("old", old));
    await utimes(`${path}.1`, old, old);
    await writeFile(path, record("recent", new Date(now - 60_000)));
    // A writer that opened the full file before it was rotated appends to it right after the read checked its time.
    afterStat = {
      path: `${path}.1`,
      run: () =>
        appendFile(`${path}.1`, record("raced", new Date(now - 30_000))),
    };
    const target = { id: "t", name: "working", logRoot } as never;
    const result = await createRuntimeFiles().logs(target, undefined, 50, {
      since: new Date(now - 3600_000).toISOString(),
    });
    // Without the second check the position would lie past it: ["recent"] alone.
    expect(result.entries.map((entry) => entry.line)).toEqual([
      "recent",
      "raced",
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
