import { afterEach, expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeFiles } from "../src/adapters/runtime-files";
import {
  acquireRotationLock,
  dropCurrentFile,
  appendTargetLog,
  rotateLogFile,
} from "../src/providers/target-log";
import {
  completeEnd,
  linesBackward,
  LOG_WINDOW_BYTES,
} from "../src/adapters/log-files";
import { snapshotHolds } from "../src/adapters/target-log-reader";
import { logComponentName } from "../src/daemon/protocol";
import { open } from "node:fs/promises";
import { DEFAULT_LOG_RETENTION } from "../src/domain/log-retention";
import type { TargetRecord } from "../src/domain/runtime";
import type { LogFilter } from "../src/domain/log-filter";
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
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
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
  const retention = { maxBytes: 20, generations: 1 };
  // Eight-byte lines against a 20-byte limit: the file rotates once it holds three.
  for (let n = 1; n <= 7; n += 1)
    await appendTargetLog(target.logRoot, line(n), retention);
  expect(await readFile(path, "utf8")).toBe(line(7));
  expect(await readFile(`${path}.1`, "utf8")).toBe(line(4) + line(5) + line(6));
  await rm(target.logRoot, { recursive: true, force: true });
  await appendTargetLog(target.logRoot, line(8), retention);
  expect(await readFile(path, "utf8")).toBe(line(8));
});
test("the default retention is today's: 64 MiB and one previous generation", () => {
  expect(DEFAULT_LOG_RETENTION).toEqual({
    maxBytes: 64 * 1024 * 1024,
    generations: 1,
  });
});
test("the writer keeps the configured number of generations, newest as .1, and drops older ones", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  const line = (n: number) => `{"n":${n}}\n`;
  const retention = { maxBytes: 16, generations: 3 };
  // Two eight-byte lines fill a file; a stale .4 left by a larger setting is removed at the next rotation.
  await writeFile(`${path}.4`, "stale\n");
  for (let n = 1; n <= 11; n += 1)
    await appendTargetLog(target.logRoot, line(n), retention);
  expect(await readFile(path, "utf8")).toBe(line(11));
  expect(await readFile(`${path}.1`, "utf8")).toBe(line(9) + line(10));
  expect(await readFile(`${path}.2`, "utf8")).toBe(line(7) + line(8));
  expect(await readFile(`${path}.3`, "utf8")).toBe(line(5) + line(6));
  expect(await exists(`${path}.4`)).toBe(false);
  expect(await exists(`${path}.rotating`)).toBe(false);
});
test("zero generations starts a fresh file at the limit and keeps no older one", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(`${path}.1`, "stale\n");
  const retention = { maxBytes: 16, generations: 0 };
  for (let n = 1; n <= 3; n += 1)
    await appendTargetLog(target.logRoot, `{"n":${n}}\n`, retention);
  expect(await readFile(path, "utf8")).toBe(`{"n":3}\n`);
  expect(await exists(`${path}.1`)).toBe(false);
});
test("a rotation already under way elsewhere is not repeated, and a lock left by a crashed writer is passed over", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  const retention = { maxBytes: 8, generations: 1 };
  await writeFile(path, "0123456789\n");
  const metadata = await stat(path);
  const lock = `${path}.rotating-${metadata.dev}-${metadata.ino}-0`;
  await writeFile(lock, "");
  await rotateLogFile(path, retention);
  expect(await readFile(path, "utf8")).toBe("0123456789\n");
  expect(await exists(`${path}.1`)).toBe(false);
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  await rotateLogFile(path, retention);
  expect(await exists(path)).toBe(false);
  expect(await readFile(`${path}.1`, "utf8")).toBe("0123456789\n");
  // Every lock of the rotated file is gone.
  expect(
    (await readdir(target.logRoot)).filter((name) => name.includes("rotating")),
  ).toEqual([]);
  // A missing file or directory is nothing to rotate.
  await rotateLogFile(join(target.logRoot, "gone", "target.jsonl"), retention);
});
const record = (
  component: string,
  line: string,
  timestamp: string,
  stream: "stdout" | "stderr" = "stdout",
) => JSON.stringify({ timestamp, component, stream, line }) + "\n";
test("a filtered read spans every retained generation, oldest first, and keeps only matching entries", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(
    `${path}.2`,
    record("scheduler", "too old", "2026-09-28T10:00:00Z") +
      record("scheduler", "gen2", "2026-09-28T11:10:00Z"),
  );
  await writeFile(
    `${path}.1`,
    record("web", "web gen1", "2026-09-28T11:20:00Z") +
      record("scheduler", "gen1 err", "2026-09-28T11:30:00Z", "stderr"),
  );
  await writeFile(
    path,
    record("scheduler", "current", "2026-09-28T11:40:00Z") +
      record("web", "web current", "2026-09-28T11:50:00Z"),
  );
  await writeFile(join(target.logRoot, "scheduler.stderr.log"), "crash\n");
  const read = (filter: LogFilter, lines = 50) =>
    files
      .logs(target, undefined, lines, filter)
      .then((result) => result.entries.map((entry) => entry.line));
  const since = "2026-09-28T11:00:00.000Z";
  expect(await read({ services: ["scheduler"], since })).toEqual([
    "gen2",
    "gen1 err",
    "current",
  ]);
  expect(await read({ services: ["scheduler"], since }, 2)).toEqual([
    "gen1 err",
    "current",
  ]);
  expect(await read({ stream: "stderr" })).toEqual(["crash", "gen1 err"]);
  expect(
    await read({
      until: "2026-09-28T11:20:00Z",
      services: ["web", "scheduler"],
    }),
  ).toEqual(["too old", "gen2", "web gen1"]);
  expect(await read({})).toEqual([
    "crash",
    "too old",
    "gen2",
    "web gen1",
    "gen1 err",
    "current",
    "web current",
  ]);
  expect(
    (await files.logs(target, undefined, 50)).entries.map((e) => e.line),
  ).toEqual(await read({}));
});
test("--lines counts matching entries, so a quiet Service's lines are found under megabytes of another's", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  const chatter = (hour: number) =>
    record("web", "x".repeat(200), `2026-09-28T${hour}:30:00Z`).repeat(15000);
  await writeFile(
    `${path}.1`,
    record("scheduler", "early", "2026-09-28T10:00:00Z") + chatter(10),
  );
  await writeFile(
    path,
    chatter(11) +
      record("scheduler", "late", "2026-09-28T12:00:00Z") +
      chatter(12),
  );
  const result = await files.logs(target, undefined, 5, {
    services: ["scheduler"],
  });
  expect(result.entries.map((entry) => entry.line)).toEqual(["early", "late"]);
});
test("a read that reaches its since bound does not open older generations", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(
    `${path}.2`,
    record("web", "ancient", "2026-09-27T00:00:00Z"),
  );
  await writeFile(
    `${path}.1`,
    record("web", "old", "2026-09-28T09:00:00Z") +
      record("web", "older than since", "2026-09-28T10:00:00Z"),
  );
  await writeFile(path, record("web", "recent", "2026-09-28T11:30:00Z"));
  // Each generation was last written when its newest line was.
  await utimes(
    `${path}.2`,
    new Date("2026-09-27T00:00:00Z"),
    new Date("2026-09-27T00:00:00Z"),
  );
  await utimes(
    `${path}.1`,
    new Date("2026-09-28T10:00:00Z"),
    new Date("2026-09-28T10:00:00Z"),
  );
  await chmod(`${path}.2`, 0o000);
  try {
    const result = await files.logs(target, undefined, 50, {
      since: "2026-09-28T11:00:00Z",
    });
    expect(result.entries.map((entry) => entry.line)).toEqual(["recent"]);
    await expect(files.logs(target, undefined, 50)).rejects.toMatchObject({
      code: "LOG_UNREADABLE",
    });
  } finally {
    await chmod(`${path}.2`, 0o600);
  }
});
test("a record appended after newer ones, its writer held up across a sleep, does not end a since read early", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(
    path,
    record("web", "before the window", "2026-09-28T10:00:00Z") +
      record("web", "after wake 1", "2026-09-28T11:30:00Z") +
      record("web", "after wake 2", "2026-09-28T11:31:00Z") +
      // Timed before the Mac slept, written after it woke.
      record("worker", "timed before sleep", "2026-09-28T09:00:00Z") +
      record("web", "after wake 3", "2026-09-28T11:32:00Z"),
  );
  const result = await files.logs(target, undefined, 50, {
    since: "2026-09-28T11:00:00Z",
  });
  expect(result.entries.map((entry) => entry.line)).toEqual([
    "after wake 1",
    "after wake 2",
    "after wake 3",
  ]);
});
test("a late record at the top of the current file does not hide a match in the generation it was rotated from", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(
    `${path}.1`,
    record("web", "before the window", "2026-09-28T10:00:00Z") +
      record("web", "rotated match", "2026-09-28T11:30:00Z"),
  );
  await utimes(
    `${path}.1`,
    new Date("2026-09-28T11:30:00Z"),
    new Date("2026-09-28T11:30:00Z"),
  );
  // Timed before a sleep, written just after the rotation.
  await writeFile(
    path,
    record("worker", "timed before sleep", "2026-09-28T09:00:00Z"),
  );
  const result = await files.logs(target, undefined, 50, {
    since: "2026-09-28T11:00:00Z",
  });
  expect(result.entries.map((entry) => entry.line)).toEqual(["rotated match"]);
});
test("a filtered follow returns only matching new entries and still advances past the rest", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, record("web", "before", "2026-09-28T11:00:00Z"));
  const filter: LogFilter = { services: ["scheduler"], stream: "stdout" };
  const first = await files.logs(target, undefined, 10, filter);
  expect(first.entries).toEqual([]);
  await appendFile(
    path,
    record("web", "web", "2026-09-28T11:00:01Z") +
      record("scheduler", "tick", "2026-09-28T11:00:02Z") +
      record("scheduler", "oops", "2026-09-28T11:00:03Z", "stderr"),
  );
  await writeFile(join(target.logRoot, "scheduler.stdout.log"), "wrapper\n");
  const next = await files.logs(target, first.cursor, 10, filter);
  expect(next.entries.map((entry) => entry.line)).toEqual(["wrapper", "tick"]);
  expect((await files.logs(target, next.cursor, 10, filter)).entries).toEqual(
    [],
  );
});
test("a follow continues across a rotation that shifts every generation", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(`${path}.1`, entry("a", "2026-09-09T12:00:00Z"));
  await writeFile(path, entry("b", "2026-09-09T12:00:01Z"));
  const first = await files.logs(target, undefined, 10);
  expect(first.entries.map((row) => row.line)).toEqual(["a", "b"]);
  await appendFile(path, entry("c", "2026-09-09T12:00:02Z"));
  await rename(`${path}.1`, `${path}.2`);
  await rename(path, `${path}.1`);
  await writeFile(path, entry("d", "2026-09-09T12:00:03Z"));
  const second = await files.logs(target, first.cursor, 10);
  expect(second.entries.map((row) => row.line)).toEqual(["c", "d"]);
  // The oldest generation dropping out of retention is not a cursor problem.
  await appendFile(path, entry("e", "2026-09-09T12:00:04Z"));
  await rm(`${path}.2`);
  await rename(`${path}.1`, `${path}.2`);
  await rename(path, `${path}.1`);
  await writeFile(path, entry("f", "2026-09-09T12:00:05Z"));
  expect(
    (await files.logs(target, second.cursor, 10)).entries.map(
      (row) => row.line,
    ),
  ).toEqual(["e", "f"]);
});
test("a follow continues across a rotated launchd wrapper log", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "web.stderr.log");
  await writeFile(path, "one\n");
  const first = await files.logs(target, undefined, 10);
  await appendFile(path, "two\n");
  await rename(path, `${path}.1`);
  await writeFile(path, "three\n");
  const next = await files.logs(target, first.cursor, 10);
  expect(next.entries.map((row) => row.line)).toEqual(["two", "three"]);
  expect(
    (await files.logs(target, undefined, 10)).entries.map((row) => row.line),
  ).toEqual(["one", "two", "three"]);
});
/** `rig` against these files: the client does what rigd's logs read does with the request it is sent. */
async function rigLogs(
  target: TargetRecord,
  args: readonly string[],
  options: { now?: Date; wait?: (poll: number) => Promise<void> } = {},
) {
  const { runRigCli } = await import("../src/cli/rig");
  const { commandSchema } = await import("../src/daemon/protocol");
  const files = createRuntimeFiles();
  const controller = new AbortController();
  const requests: unknown[] = [];
  let out = "",
    err = "",
    polls = 0;
  const code = await runRigCli(["logs", ...args], {
    root: target.logRoot,
    cwd: target.logRoot,
    signal: controller.signal,
    now: () => options.now ?? new Date(),
    wait: async () => {
      polls++;
      if (options.wait) await options.wait(polls);
      else controller.abort();
      if (polls > 1) controller.abort();
    },
    client: {
      async status() {
        throw new Error("Unexpected status");
      },
      async command(raw) {
        const request = commandSchema.parse(raw);
        requests.push(request);
        return {
          project: "app",
          target: request.target ?? target.name,
          ...(await files.logs(
            target,
            request.after,
            request.lines ?? 100,
            request.logFilter,
          )),
          ...(request.logFilter ? { filtered: true } : {}),
        };
      },
    },
    output: {
      write(value) {
        out += value;
      },
      error(value) {
        err += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    newOperationId: () => "logs",
  });
  return { code, out, err, requests };
}
test("rig logs local --service scheduler --since 1h prints only that Service's last hour, reaching into the rotated generation", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(
    `${path}.1`,
    record("scheduler", "two hours ago", "2026-09-28T10:00:00Z") +
      record("scheduler", "rotated tick", "2026-09-28T11:05:00Z") +
      record("web", "rotated web", "2026-09-28T11:06:00Z"),
  );
  await writeFile(
    path,
    record("web", "web line", "2026-09-28T11:30:00Z") +
      record("scheduler", "current tick", "2026-09-28T11:45:00Z", "stderr") +
      record("worker", "worker line", "2026-09-28T11:50:00Z"),
  );
  const result = await rigLogs(
    target,
    ["local", "--service", "scheduler", "--since", "1h"],
    { now: new Date("2026-09-28T12:00:00Z") },
  );
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(result.out).toBe(
    "app local\n\n" +
      "11:05:00Z  scheduler  > rotated tick\n" +
      "11:45:00Z  scheduler  ! current tick\n",
  );
});
test("rig logs --follow keeps to --service and --stream", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(
    path,
    record("scheduler", "history", "2026-09-28T11:00:00Z") +
      record("web", "web history", "2026-09-28T11:00:01Z"),
  );
  const result = await rigLogs(
    target,
    ["local", "--follow", "--service", "scheduler", "--stream", "stdout"],
    {
      wait: async (poll) => {
        if (poll === 1)
          await appendFile(
            path,
            record("web", "web new", "2026-09-28T11:01:00Z") +
              record("scheduler", "scheduler new", "2026-09-28T11:01:01Z") +
              record(
                "scheduler",
                "scheduler err",
                "2026-09-28T11:01:02Z",
                "stderr",
              ),
          );
      },
    },
  );
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(result.out).toBe(
    "app local\n\n" +
      "11:00:00Z  scheduler  > history\n" +
      "11:01:01Z  scheduler  > scheduler new\n",
  );
  expect(result.requests).toHaveLength(2);
  expect(result.requests[1]).toMatchObject({
    lines: 1000,
    logFilter: { services: ["scheduler"], stream: "stdout" },
  });
});
test("a follow under zero generations carries on when the full file is deleted, for Rig's records and launchd's files alike", async () => {
  const target = await fixture(),
    files = createRuntimeFiles();
  for (const name of ["target.jsonl", "web.stdout.log"]) {
    const path = join(target.logRoot, name);
    await writeFile(path, name === "target.jsonl" ? entry("a") : "a\n");
    const first = await files.logs(target, undefined, 10);
    await rotateLogFile(path, { maxBytes: 1, generations: 0 });
    const gone = await files.logs(target, first.cursor, 10);
    expect(gone.entries).toEqual([]);
    await writeFile(path, name === "target.jsonl" ? entry("b") : "b\n");
    expect(
      (await files.logs(target, gone.cursor, 10)).entries.map((e) => e.line),
    ).toEqual(["b"]);
    await rm(path);
  }
  // A missing log directory, or a legacy file replaced underneath the follow, is still a cursor problem.
  await writeFile(join(target.logRoot, "events.jsonl"), "");
  const legacy = await files.logs(target, undefined, 10);
  await rm(join(target.logRoot, "events.jsonl"));
  await writeFile(join(target.logRoot, "events.jsonl"), "");
  await expect(files.logs(target, legacy.cursor, 10)).rejects.toMatchObject({
    code: "LOG_CURSOR",
  });
  const cursor = (await files.logs(target, undefined, 10)).cursor;
  await rm(target.logRoot, { recursive: true, force: true });
  await expect(files.logs(target, cursor, 10)).rejects.toMatchObject({
    code: "LOG_CURSOR",
  });
});
test("a recent read over a file of unreadable records stops a window past the page instead of walking every generation", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(`${path}.1`, entry("older"));
  await writeFile(path, "not json\n".repeat(700_000));
  await chmod(`${path}.1`, 0o000);
  try {
    const result = await files.logs(target, undefined, 3);
    expect(result.entries).toEqual(
      Array(3).fill({
        timestamp: "unknown",
        component: "unknown",
        stream: "unknown",
        line: "Rig skipped an unreadable log record (8 bytes).",
      }),
    );
    // A filter that no unreadable record can pass never holds them, and finds the older line.
    await chmod(`${path}.1`, 0o600);
    const filtered = await files.logs(target, undefined, 3, {
      services: ["web"],
    });
    expect(filtered.entries.map((e) => e.line)).toEqual(["older"]);
  } finally {
    await chmod(`${path}.1`, 0o600);
  }
});

test("a lock left stale is never taken from anyone: writers that find it race to create the next one, and only one wins", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, "0123456789\n");
  const stale = `${path}.rotating-1-2-0`;
  await writeFile(stale, "");
  const old = new Date(Date.now() - 120_000);
  await utimes(stale, old, old);
  const won = await Promise.all(
    Array.from({ length: 8 }, () => acquireRotationLock(path, "1-2")),
  );
  expect(won.filter(Boolean)).toEqual([`${path}.rotating-1-2-1`]);
  // The winner removed the stale lock it passed over, so its holder, should it wake, stops; the new lock is fresh.
  expect(await exists(stale)).toBe(false);
  expect(await acquireRotationLock(path, "1-2")).toBeUndefined();
  // Another file's locks are its own.
  expect(await acquireRotationLock(path, "1-3")).toBe(`${path}.rotating-1-3-0`);
  // Rotating the current file clears its own locks and stale locks of earlier files, but not a fresh lock of another.
  const metadata = await stat(path);
  await writeFile(`${path}.rotating-${metadata.dev}-${metadata.ino}-0`, "");
  const oldStale = new Date(Date.now() - 120_000);
  await utimes(
    `${path}.rotating-${metadata.dev}-${metadata.ino}-0`,
    oldStale,
    oldStale,
  );
  await rotateLogFile(path, { maxBytes: 8, generations: 1 });
  expect(
    (await readdir(target.logRoot))
      .filter((name) => name.includes("rotating"))
      .sort(),
  ).toEqual(["target.jsonl.rotating-1-2-1", "target.jsonl.rotating-1-3-0"]);
});

test("a rotation drops every generation past retention, even after a gap an interrupted rotation left", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, "0123456789\n");
  await writeFile(`${path}.1`, "one\n");
  await writeFile(`${path}.3`, "three\n");
  await writeFile(`${path}.12`, "twelve\n");
  await rotateLogFile(path, { maxBytes: 8, generations: 1 });
  expect(await readFile(`${path}.1`, "utf8")).toBe("0123456789\n");
  for (const gone of [".2", ".3", ".12"])
    expect(await exists(`${path}${gone}`)).toBe(false);
});

test("finding where complete lines end reads at most a window back, so an endless unterminated line is not scanned whole", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "web.stdout.log");
  await writeFile(path, `first\n${"x".repeat(100)}`);
  let handle = await open(path, "r");
  expect(await completeEnd(handle, (await handle.stat()).size)).toEqual({
    end: 6,
    midRecord: false,
  });
  await handle.close();
  await writeFile(path, `first\n${"\r".repeat(3 * LOG_WINDOW_BYTES)}`);
  handle = await open(path, "r");
  const size = (await handle.stat()).size;
  let read = 0;
  const counting = new Proxy(handle, {
    get(target, key, receiver) {
      if (key === "read")
        return async (...args: Parameters<typeof handle.read>) => {
          const result = await target.read(...args);
          read += result.bytesRead;
          return result;
        };
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(await completeEnd(counting, size)).toEqual({
    end: size,
    midRecord: true,
  });
  expect(read).toBeLessThanOrEqual(LOG_WINDOW_BYTES + 1);
  await handle.close();
});

test("a family --service or a time bound excludes is not opened, so an unreadable one does not fail the read or the follow", async () => {
  const target = await fixture(),
    files = createRuntimeFiles();
  await writeFile(
    join(target.logRoot, "target.jsonl"),
    record("scheduler", "tick", "2026-09-09T12:00:00Z"),
  );
  const web = join(target.logRoot, "web.stderr.log");
  await writeFile(web, "web noise\n");
  await chmod(web, 0o000);
  try {
    for (const filter of [
      { services: ["scheduler"] },
      { since: "2026-09-09T11:00:00Z" },
    ] satisfies LogFilter[]) {
      const first = await files.logs(target, undefined, 10, filter);
      expect(first.entries.map((each) => each.line)).toEqual(["tick"]);
      await appendFile(
        join(target.logRoot, "target.jsonl"),
        record("scheduler", "tock", "2026-09-09T12:01:00Z"),
      );
      const next = await files.logs(target, first.cursor, 10, filter);
      expect(next.entries.map((each) => each.line)).toEqual(["tock"]);
      await writeFile(
        join(target.logRoot, "target.jsonl"),
        record("scheduler", "tick", "2026-09-09T12:00:00Z"),
      );
    }
    await expect(files.logs(target, undefined, 10)).rejects.toMatchObject({
      code: "LOG_UNREADABLE",
    });
  } finally {
    await chmod(web, 0o600);
  }
});

test("--service accepts any Service name config accepts, however long", () => {
  expect(logComponentName.safeParse("a".repeat(300)).success).toBe(true);
  expect(logComponentName.safeParse("-bad").success).toBe(false);
});

test("a snapshot of the log files holds only while nothing rotated: no new or vanished name, each name the same file, no file under two names", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, entry("one"));
  const identity = async (file: string) => {
    const metadata = await stat(file);
    return `${metadata.dev}:${metadata.ino}`;
  };
  const before = await identity(path);
  expect(
    await snapshotHolds(
      target.logRoot,
      ["target.jsonl"],
      { "target.jsonl": before },
      {},
    ),
  ).toBe(true);
  // A rotation after the listing: the listed name is now another file, and a generation appeared.
  await rename(path, `${path}.1`);
  await writeFile(path, entry("two"));
  expect(
    await snapshotHolds(
      target.logRoot,
      ["target.jsonl"],
      { "target.jsonl": before },
      {},
    ),
  ).toBe(false);
  expect(
    await snapshotHolds(
      target.logRoot,
      ["target.jsonl", "target.jsonl.1"],
      { "target.jsonl": before, "target.jsonl.1": before },
      {},
    ),
  ).toBe(false);
  expect(
    await snapshotHolds(
      target.logRoot,
      ["target.jsonl", "target.jsonl.1"],
      { "target.jsonl": await identity(path), "target.jsonl.1": before },
      {},
    ),
  ).toBe(true);
});

test("a launchd file whose last line never ends is read only a window back for the newest line, not scanned whole", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "web.stdout.log");
  await writeFile(path, `ready\n${"#".repeat(8 * LOG_WINDOW_BYTES)}`);
  const recent = await files.logs(target, undefined, 1);
  expect(recent.entries).toEqual([
    {
      timestamp: "unknown",
      component: "unknown",
      stream: "unknown",
      line: expect.stringMatching(
        /^Rig skipped an unreadable log record \(more than \d+ bytes\)\.$/,
      ),
    },
  ]);
  // Reading back to the newest line stops a chunk past the window.
  const handle = await open(path, "r");
  let read = 0;
  const counting = new Proxy(handle, {
    get(target, key, receiver) {
      if (key === "read")
        return async (...args: Parameters<typeof handle.read>) => {
          const result = await target.read(...args);
          read += result.bytesRead;
          return result;
        };
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const size = (await handle.stat()).size;
  const complete = await completeEnd(counting, size);
  const lines = linesBackward(counting, complete.end, complete.midRecord);
  expect((await lines.next()).value).toMatchObject({ atLeast: true });
  await lines.return(undefined);
  // Far less than the 32 MiB file: the window completeEnd searches, and the window the run is known past.
  expect(read).toBeLessThanOrEqual(2 * (LOG_WINDOW_BYTES + 1024 * 1024));
  await handle.close();
});

test("a holder that stalled past the stale age and lost its lock to another writer stops instead of rotating again", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  const retention = { maxBytes: 8, generations: 2 };
  await writeFile(path, "0123456789\n");
  await writeFile(`${path}.1`, "older\n");
  const metadata = await stat(path);
  const identity = `${metadata.dev}-${metadata.ino}`;
  // The stalled holder's lock, old enough to be passed over.
  const stalled = await acquireRotationLock(path, identity);
  const old = new Date(Date.now() - 120_000);
  await utimes(stalled!, old, old);
  // Another writer passes it over and rotates.
  await rotateLogFile(path, retention);
  expect(await readFile(`${path}.1`, "utf8")).toBe("0123456789\n");
  expect(await readFile(`${path}.2`, "utf8")).toBe("older\n");
  expect(await exists(stalled!)).toBe(false);
  // New output fills a new file; the stalled holder's lock is gone, so nothing it could still do shifts .1 or .2.
  await writeFile(path, "abcdefghij\n");
  await rotateLogFile(path, retention);
  expect(await readFile(`${path}.1`, "utf8")).toBe("abcdefghij\n");
  expect(await readFile(`${path}.2`, "utf8")).toBe("0123456789\n");
});

test("a follow does not open older generations it is not following, so a Target with many of them reads with few files open", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, entry("current"));
  for (let generation = 1; generation <= 3; generation++) {
    await writeFile(`${path}.${generation}`, entry(`old ${generation}`));
    await chmod(`${path}.${generation}`, 0o000);
  }
  try {
    const first = await files.logs(target, undefined, 1);
    expect(first.entries.map((each) => each.line)).toEqual(["current"]);
    await appendFile(path, entry("next", "2026-09-09T12:00:01Z"));
    // Unreadable older generations are never touched: they are not followed.
    const next = await files.logs(target, first.cursor, 10);
    expect(next.entries.map((each) => each.line)).toEqual(["next"]);
  } finally {
    for (let generation = 1; generation <= 3; generation++)
      await chmod(`${path}.${generation}`, 0o600);
  }
});

test("a follow from a read that ended inside an over-long launchd line skips the rest of that line instead of showing it as a new one", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "web.stdout.log");
  await writeFile(path, `ready\n${"#".repeat(LOG_WINDOW_BYTES + 10)}`);
  const first = await files.logs(target, undefined, 5);
  expect(first.entries.map((each) => each.line)).toEqual([
    "ready",
    `Rig skipped an unreadable log record (${LOG_WINDOW_BYTES + 10} bytes).`,
  ]);
  await appendFile(path, "still the same line");
  const middle = await files.logs(target, first.cursor, 5);
  expect(middle.entries).toEqual([]);
  await appendFile(path, " and its end\nnext line\n");
  const next = await files.logs(target, middle.cursor, 5);
  expect(next.entries.map((each) => each.line)).toEqual(["next line"]);
});

test("under zero generations a holder deletes only the full file it locked; a newer file found in its place is kept", async () => {
  const target = await fixture(),
    path = join(target.logRoot, "target.jsonl");
  await writeFile(path, "full\n");
  const full = await stat(path);
  // Passed over while stalled: another writer already deleted the full file, and new output started a new one.
  await rm(path);
  await writeFile(path, "newer\n");
  await dropCurrentFile(path, `${full.dev}-${full.ino}`);
  expect(await readFile(path, "utf8")).toBe("newer\n");
  // The full file itself is deleted.
  const current = await stat(path);
  await dropCurrentFile(path, `${current.dev}-${current.ino}`);
  expect(await exists(path)).toBe(false);
  expect(
    (await readdir(target.logRoot)).filter((name) => name.includes("dropping")),
  ).toEqual([]);
});

test("a long follow stops following generations two rotations old once read, so its open files stay few", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  const retention = { maxBytes: 64, generations: 20 };
  await appendTargetLog(target.logRoot, entry("start"), retention);
  let cursor = (await files.logs(target, undefined, 10)).cursor;
  const seen: string[] = [];
  for (let n = 0; n < 12; n++) {
    await appendTargetLog(
      target.logRoot,
      entry(
        `line ${n}`,
        `2026-09-09T12:00:${String(10 + n).padStart(2, "0")}Z`,
      ),
      retention,
    );
    const next = await files.logs(target, cursor, 100);
    seen.push(...next.entries.map((each) => each.line));
    cursor = next.cursor;
  }
  expect(seen).toEqual(Array.from({ length: 12 }, (_, n) => `line ${n}`));
  expect(await exists(`${path}.5`)).toBe(true);
  const followed = Object.keys(
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).sources,
  );
  expect(followed.length).toBeLessThanOrEqual(3);
});

test("a launchd line that grows past the window during a follow is reported once, and its end is not shown as a line of its own", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "web.stdout.log");
  await writeFile(path, "ready\n");
  const first = await files.logs(target, undefined, 5);
  await appendFile(path, "#".repeat(LOG_WINDOW_BYTES + 10));
  const grown = await files.logs(target, first.cursor, 5);
  expect(grown.entries.map((each) => each.line)).toEqual([
    `Rig skipped an unreadable log record (more than ${LOG_WINDOW_BYTES + 10} bytes).`,
  ]);
  await appendFile(path, "its end\nnext line\n");
  const next = await files.logs(target, grown.cursor, 5);
  expect(next.entries.map((each) => each.line)).toEqual(["next line"]);
});

test("two rotations between follow reads leave a generation the follow never saw, and it is read from its start", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "target.jsonl");
  const retention = { maxBytes: 64, generations: 1 };
  await appendTargetLog(
    target.logRoot,
    entry("start", "2026-09-09T12:00:00Z"),
    retention,
  );
  const first = await files.logs(target, undefined, 10);
  // Two rotations: the followed file is evicted, the one after it is now .1, and a third is current.
  for (let n = 1; n <= 4; n++)
    await appendTargetLog(
      target.logRoot,
      entry(`line ${n}`, `2026-09-09T12:00:0${n}Z`),
      retention,
    );
  expect(await exists(`${path}.1`)).toBe(true);
  const next = await files.logs(target, first.cursor, 100);
  const seen = next.entries.map((each) => each.line);
  // Whatever the evicted file held past the cursor is gone with it; every retained line is shown, in order.
  const retained = [
    ...(await readFile(`${path}.1`, "utf8")).trim().split("\n"),
    ...(await readFile(path, "utf8")).trim().split("\n"),
  ].map((line) => JSON.parse(line).line);
  expect(seen.slice(-retained.length)).toEqual(retained);
  expect(retained.length).toBeGreaterThan(1);
});

test("a follow passes an endless launchd line a window per read, however far it has grown, and resumes at its end", async () => {
  const target = await fixture(),
    files = createRuntimeFiles(),
    path = join(target.logRoot, "web.stdout.log");
  await writeFile(path, "ready\n");
  let cursor = (await files.logs(target, undefined, 5)).cursor;
  await appendFile(
    path,
    "#".repeat(4 * LOG_WINDOW_BYTES) + " its end\nnext line\n",
  );
  const shown: string[] = [];
  let reads = 0;
  while (!shown.includes("next line") && reads < 10) {
    const next = await files.logs(target, cursor, 5);
    shown.push(...next.entries.map((each) => each.line));
    cursor = next.cursor;
    reads++;
  }
  expect(shown).toEqual([
    `Rig skipped an unreadable log record (more than ${2 * LOG_WINDOW_BYTES} bytes).`,
    "next line",
  ]);
  // Each read passed at most a window of the run.
  expect(reads).toBeGreaterThanOrEqual(3);
});

test("a family that appears and rotates after a follow began is read whole, its rotated generation included", async () => {
  const target = await fixture(),
    files = createRuntimeFiles();
  await writeFile(join(target.logRoot, "target.jsonl"), entry("start"));
  const first = await files.logs(target, undefined, 10);
  // A launchd job starts after the follow began, writes, and its file is rotated when the job starts again.
  const job = join(target.logRoot, "worker.stderr.log");
  await writeFile(job, "first run\n");
  await rotateLogFile(job, { maxBytes: 1, generations: 1 });
  await writeFile(job, "second run\n");
  const next = await files.logs(target, first.cursor, 10);
  expect(next.entries.map((each) => each.line)).toEqual([
    "first run",
    "second run",
  ]);
});
