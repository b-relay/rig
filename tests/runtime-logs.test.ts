import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeFiles } from "../src/adapters/runtime-files";
import type { TargetRecord } from "../src/domain/runtime";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const logRoot = await mkdtemp(join(tmpdir(), "rig-logs-"));
  roots.push(logRoot);
  return {
    id: "target-1",
    name: "live",
    logRoot,
    plan: { project: "app", components: [] },
  } as unknown as TargetRecord;
}
const entry = (line: string, timestamp = "2026-09-09T12:00:00Z") =>
  JSON.stringify({ timestamp, component: "web", stream: "stdout", line }) +
  "\n";
test("retained legacy application logs preserve known evidence and mark combined stream and time unknown", async () => {
  const target = await fixture(),
    files = createRuntimeFiles();
  await writeFile(join(target.logRoot, "web.launchd.log"), "legacy output\n");
  await writeFile(
    join(target.logRoot, "events.jsonl"),
    JSON.stringify({
      timestamp: "2026-09-09T11:00:00Z",
      event: "component.log",
      component: "api",
      details: { stream: "stderr", line: "old error" },
    }) +
      "\n" +
      JSON.stringify({
        timestamp: "2026-09-09T11:01:00Z",
        event: "component.started",
        details: { secret: "must not render" },
      }) +
      "\n",
  );
  await writeFile(join(target.logRoot, "target.jsonl"), entry("new output"));
  const result = await files.logs(target, undefined, 10);
  expect(result.entries).toEqual([
    {
      timestamp: "unknown",
      component: "web",
      stream: "unknown",
      line: "legacy output",
    },
    {
      timestamp: "2026-09-09T11:00:00Z",
      component: "api",
      stream: "stderr",
      line: "old error",
    },
    {
      timestamp: "2026-09-09T12:00:00Z",
      component: "web",
      stream: "stdout",
      line: "new output",
    },
  ]);
  expect(await readFile(join(target.logRoot, "web.launchd.log"), "utf8")).toBe(
    "legacy output\n",
  );
});
test("follow defers incomplete JSONL until newline and keeps repeated text as distinct records", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  const row = entry("repeat 😀");
  await writeFile(path, row + row.slice(0, 25));
  const first = await files.logs(target, undefined, 10);
  expect(first.entries).toHaveLength(1);
  expect((await files.logs(target, first.cursor, 10)).entries).toEqual([]);
  await appendFile(path, row.slice(25));
  const next = await files.logs(target, first.cursor, 10);
  expect(next.entries).toEqual(first.entries);
  expect((await files.logs(target, next.cursor, 10)).entries).toEqual([]);
});
test("limited follow merges dated sources without skipping another source or repeating consumed entries", async () => {
  const target = await fixture(),
    files = createRuntimeFiles();
  const initial = await files.logs(target, undefined, 2);
  await writeFile(
    join(target.logRoot, "target.jsonl"),
    entry("new-one", "2026-09-09T12:00:00Z") +
      entry("new-three", "2026-09-09T12:00:02Z"),
  );
  await writeFile(
    join(target.logRoot, "events.jsonl"),
    JSON.stringify({
      timestamp: "2026-09-09T12:00:01Z",
      event: "component.log",
      component: "api",
      details: { stream: "stdout", line: "legacy-two" },
    }) + "\n",
  );
  const first = await files.logs(target, initial.cursor, 2);
  expect(first.entries.map((value) => value.line)).toEqual([
    "new-one",
    "legacy-two",
  ]);
  const second = await files.logs(target, first.cursor, 2);
  expect(second.entries.map((value) => value.line)).toEqual(["new-three"]);
  expect((await files.logs(target, second.cursor, 2)).entries).toEqual([]);
});
test("foreign cursors, truncated files and complete invalid JSON fail truthfully without modifying logs", async () => {
  const target = await fixture(),
    other = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, entry("preserved"));
  const initial = await files.logs(target, undefined, 2);
  await expect(files.logs(other, initial.cursor, 2)).rejects.toMatchObject({
    code: "LOG_CURSOR",
  });
  await writeFile(path, "{}\n");
  await expect(files.logs(target, initial.cursor, 2)).rejects.toMatchObject({
    code: "LOG_CURSOR",
  });
  await expect(files.logs(target, undefined, 2)).rejects.toMatchObject({
    code: "LOG_CORRUPT",
  });
  expect(await readFile(path, "utf8")).toBe("{}\n");
});
test("recent reading selects a bounded tail and does not parse ancient complete history outside its window", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "web.launchd.log");
  await writeFile(
    path,
    "old line\n".repeat(600000) + "recent-one\nrecent-two\n",
  );
  expect(
    (await files.logs(target, undefined, 2)).entries.map((value) => value.line),
  ).toEqual(["recent-one", "recent-two"]);
});
