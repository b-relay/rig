import { afterEach, expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeFiles } from "../src/adapters/runtime-files";
import { appendTargetLog } from "../src/providers/target-log";
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
  expect((await files.logs(target, undefined, 2)).entries).toEqual([
    {
      timestamp: "unknown",
      component: "unknown",
      stream: "unknown",
      line: "Rig skipped an unreadable log record (2 bytes).",
    },
  ]);
  expect(await readFile(path, "utf8")).toBe("{}\n");
});
test("an unreadable complete record is reported in place and follow advances past it", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(
    path,
    entry("one", "2026-09-09T12:00:01Z") +
      "{}\n" +
      entry("three", "2026-09-09T12:00:03Z"),
  );
  expect(
    (await files.logs(target, undefined, 10)).entries.map((e) => [
      e.timestamp,
      e.stream,
      e.line,
    ]),
  ).toEqual([
    ["2026-09-09T12:00:01Z", "stdout", "one"],
    [
      "2026-09-09T12:00:01Z",
      "unknown",
      "Rig skipped an unreadable log record (2 bytes).",
    ],
    ["2026-09-09T12:00:03Z", "stdout", "three"],
  ]);
  const initial = await files.logs(target, undefined, 10);
  // A record cut short and glued onto the next one is a single unreadable line.
  await appendFile(
    path,
    '{"timestamp":"2026-09-09T12:00:04Z","glued' +
      entry("four", "2026-09-09T12:00:05Z") +
      entry("five", "2026-09-09T12:00:06Z"),
  );
  const followed = await files.logs(target, initial.cursor, 10);
  expect(followed.entries.map((e) => e.line)).toEqual([
    expect.stringContaining("Rig skipped an unreadable log record ("),
    "five",
  ]);
  expect((await files.logs(target, followed.cursor, 10)).entries).toEqual([]);
});
test("a record larger than the reader window is skipped as one marked entry and reading continues", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, entry("before", "2026-09-09T12:00:01Z"));
  const initial = await files.logs(target, undefined, 10);
  const huge = "x".repeat(5 * 1024 * 1024);
  await appendFile(path, huge + "\n" + entry("after", "2026-09-09T12:00:02Z"));
  const followed = await files.logs(target, initial.cursor, 10);
  expect(followed.entries.map((e) => [e.stream, e.line])).toEqual([
    ["unknown", `Rig skipped an unreadable log record (${huge.length} bytes).`],
  ]);
  const next = await files.logs(target, followed.cursor, 10);
  expect(next.entries.map((e) => [e.stream, e.line])).toEqual([
    ["stdout", "after"],
  ]);
  expect((await files.logs(target, next.cursor, 10)).entries).toEqual([]);
  // The tail window holds the end of the huge record: recent reads still find what follows it.
  expect(
    (await files.logs(target, undefined, 1)).entries.map((e) => e.line),
  ).toEqual(["after"]);
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

test("public follow reports reader truncation failure and preserves retained bytes", async () => {
  const target = await fixture(),
    files = createRuntimeFiles();
  const path = join(target.logRoot, "target.jsonl");
  await writeFile(path, entry("preserved"));
  const { runRigCli } = await import("../src/cli/rig");
  let errors = "",
    polls = 0;
  expect(
    await runRigCli(["logs", "live", "--follow"], {
      root: target.logRoot,
      cwd: target.logRoot,
      wait: async () => {
        await writeFile(path, "{}\n");
      },
      client: {
        async status() {
          throw new Error("Unexpected status");
        },
        async command(request) {
          polls++;
          return files.logs(target, request.after, 100);
        },
      },
      output: {
        write() {},
        error(value) {
          errors += value;
        },
      },
      diagnostics: {
        async record() {
          return {};
        },
      },
      newOperationId: () => "reader-failure",
    }),
  ).toBe(1);
  expect(polls).toBe(2);
  expect(errors).toContain("cursor is invalid or its files changed");
  expect(await readFile(path, "utf8")).toBe("{}\n");
});

test("an unreadable or non-regular Target log is reported as unreadable, not as a cursor problem", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, entry("kept"));
  const { cursor } = await files.logs(target, undefined, 2);
  await chmod(path, 0o000);
  try {
    for (const after of [undefined, cursor])
      await expect(files.logs(target, after, 2)).rejects.toMatchObject({
        code: "LOG_UNREADABLE",
        message: `The Target log ${path} could not be read (EACCES).`,
        hint: "Fix its permissions or move it aside, then read the logs again.",
      });
  } finally {
    await chmod(path, 0o600);
  }
  const directory = await fixture();
  await mkdir(join(directory.logRoot, "target.jsonl"));
  await expect(files.logs(directory, undefined, 2)).rejects.toMatchObject({
    code: "LOG_UNREADABLE",
    message: `The Target log ${join(directory.logRoot, "target.jsonl")} is not a regular file.`,
  });
  await expect(files.logs(target, "bogus", 2)).rejects.toMatchObject({
    code: "LOG_CURSOR",
  });
});
test("launchd wrapper stdout and stderr files are shown under their component with an unknown time", async () => {
  const target = await fixture(),
    files = createRuntimeFiles();
  await writeFile(join(target.logRoot, "web.stdout.log"), "");
  await writeFile(
    join(target.logRoot, "web.stderr.log"),
    "error: Cannot find module\n",
  );
  await writeFile(join(target.logRoot, "target.jsonl"), entry("dated"));
  const first = await files.logs(target, undefined, 10);
  expect(first.entries).toEqual([
    {
      timestamp: "unknown",
      component: "web",
      stream: "stderr",
      line: "error: Cannot find module",
    },
    {
      timestamp: "2026-09-09T12:00:00Z",
      component: "web",
      stream: "stdout",
      line: "dated",
    },
  ]);
  await appendFile(join(target.logRoot, "web.stderr.log"), "again\n");
  expect((await files.logs(target, first.cursor, 10)).entries).toEqual([
    { timestamp: "unknown", component: "web", stream: "stderr", line: "again" },
  ]);
});
test("a rotated Target log continues a follow without repeating or losing entries", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, entry("a") + entry("b", "2026-09-09T12:00:01Z"));
  const first = await files.logs(target, undefined, 10);
  expect(first.entries.map((row) => row.line)).toEqual(["a", "b"]);
  await appendFile(path, entry("c", "2026-09-09T12:00:02Z"));
  await rename(path, `${path}.1`);
  await writeFile(path, entry("d", "2026-09-09T12:00:03Z"));
  const second = await files.logs(target, first.cursor, 10);
  expect(second.entries.map((row) => row.line)).toEqual(["c", "d"]);
  await appendFile(path, entry("e", "2026-09-09T12:00:04Z"));
  expect(
    (await files.logs(target, second.cursor, 10)).entries.map(
      (row) => row.line,
    ),
  ).toEqual(["e"]);
  expect(
    (await files.logs(target, undefined, 10)).entries.map((row) => row.line),
  ).toEqual(["a", "b", "c", "d", "e"]);
});
test("the Target log writer rotates at its size limit and keeps one previous generation", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  const line = (n: number) => `{"n":${n}}\n`;
  // Eight-byte lines against a 20-byte limit: the file rotates once it holds three.
  for (let n = 1; n <= 7; n += 1)
    await appendTargetLog(target.logRoot, line(n), 20);
  expect(await readFile(path, "utf8")).toBe(line(7));
  expect(await readFile(`${path}.1`, "utf8")).toBe(line(4) + line(5) + line(6));
  await rm(target.logRoot, { recursive: true, force: true });
  await appendTargetLog(target.logRoot, line(8), 20);
  expect(await readFile(path, "utf8")).toBe(line(8));
});
