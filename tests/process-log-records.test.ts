import { afterEach, expect, spyOn, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTargetEffects } from "../src/adapters/target-effects";
import { readTargetLogs } from "../src/adapters/target-log-reader";
import { LOG_WINDOW_BYTES } from "../src/adapters/log-files";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { runCommand } from "../src/providers/command-runner";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";
import { appendTargetLog } from "../src/providers/target-log";
import type { TargetLogEntry } from "../src/providers/contracts";
import type { LogFilter } from "../src/domain/log-filter";
import type { TargetRecord } from "../src/domain/runtime";
import { localActivation } from "./support/activation-doubles";
import { noRoutes } from "./support/router-doubles";

const roots: string[] = [];
const supervisors: ReturnType<typeof createChildSupervisor>[] = [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.shutdown();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function tempRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `rig-records-${name}-`));
  roots.push(root);
  return root;
}
function target(root: string): TargetRecord {
  return {
    id: "t",
    projectId: "p",
    name: "working",
    kind: "working",
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan: {
      project: "demo",
      target: "working",
      workspacePath: root,
      dataRoot: root,
      deploymentName: "working",
      branchSlug: "working",
      subdomain: "working",
      providers: { processSupervisor: "child" },
      components: [],
      preparedComponents: [],
    },
  };
}
function effects(root: string) {
  return createTargetEffects({
    ...localActivation(),
    root,
    recordingTime: () => new Date().toISOString(),
    supervisors: new Map(),
    run: runCommand,
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: noRoutes(),
    environment: { PATH: process.env.PATH! },
  });
}
/** A Bun script that writes each of `parts` (byte arrays) to its stream as a chunk of its own, pausing between them so
 * no two reach the reader together. */
function chunkedScript(
  parts: readonly { stream: "stdout" | "stderr"; bytes: number[] }[],
): string {
  return `for (const part of ${JSON.stringify(parts)}) { process[part.stream].write(Buffer.from(part.bytes)); await Bun.sleep(25); }`;
}
/** Every byte of `text` as a chunk of its own on `stream`, so every byte boundary of every character is a chunk boundary. */
function byteByByte(stream: "stdout" | "stderr", text: string) {
  return [...Buffer.from(text)].map((byte) => ({ stream, bytes: [byte] }));
}
/** The newest entries `filter` keeps, as many as one read returns. */
async function allLines(
  record: TargetRecord,
  filter: LogFilter = {},
): Promise<TargetLogEntry[]> {
  return (await readTargetLogs(record, undefined, 10000, filter)).entries;
}

test("output split between chunks at every byte of a multi-byte character reaches the command result and onOutput whole", async () => {
  const root = await tempRoot("runner");
  const text = "€ é 😀 ✓\n";
  const script = join(root, "split.ts");
  await writeFile(
    script,
    chunkedScript([
      ...byteByByte("stdout", text),
      ...byteByByte("stderr", text),
    ]),
  );
  const seen = { stdout: "", stderr: "" };
  const result = await runCommand({
    command: [process.execPath, script],
    onOutput: (stream, chunk) => (seen[stream] += chunk),
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: text, stderr: text });
  expect(seen).toEqual({ stdout: text, stderr: text });
});

test("build output split between chunks at every byte of a character is recorded whole on both streams, a trailing partial line too", async () => {
  const root = await tempRoot("build-utf8");
  const record = target(root);
  const script = join(root, "split.ts");
  await writeFile(
    script,
    chunkedScript([
      ...byteByByte("stdout", "price €5 😀\nnext"),
      ...byteByByte("stderr", "warn é 😀\n"),
      // A stream that ends partway through a character keeps what came before it.
      { stream: "stdout", bytes: [...Buffer.from(" ü"), 0xf0, 0x9f] },
    ]),
  );
  await effects(root).build(
    { id: "shared", command: `${process.execPath} ${script}`, timeout: 60 },
    record,
  );
  const entries = await allLines(record, { services: ["setup"] });
  expect(entries.map(({ stream, line }) => [stream, line])).toEqual([
    ["stdout", "price €5 😀"],
    ["stderr", "warn é 😀"],
    ["stdout", "next ü\uFFFD"],
  ]);
});

test("a build line longer than the reader's window is recorded in bounded pieces that a filtered read and a follow both return whole", async () => {
  const root = await tempRoot("build-long");
  const record = target(root);
  const long = "x".repeat(LOG_WINDOW_BYTES + 200);
  // Control characters are escaped to six bytes each in a record.
  const escaped = "\u0001".repeat(300_000);
  const script = join(root, "long.ts");
  await writeFile(
    script,
    `process.stdout.write(${JSON.stringify(long)} + "\\n"); process.stdout.write(${JSON.stringify(escaped)} + "\\n"); process.stdout.write("after\\n");`,
  );
  await mkdir(record.logRoot, { recursive: true });
  const before = await readTargetLogs(record, undefined, 10, {
    services: ["setup"],
  });
  await effects(root).build(
    { id: "shared", command: `${process.execPath} ${script}`, timeout: 60 },
    record,
  );
  const records = (await readFile(join(record.logRoot, "target.jsonl"), "utf8"))
    .trim()
    .split("\n");
  for (const line of records)
    expect(Buffer.byteLength(line)).toBeLessThan(LOG_WINDOW_BYTES / 8);
  const rejoin = (entries: TargetLogEntry[]) => {
    expect(entries.every((entry) => entry.component === "setup")).toBe(true);
    const lines = entries.map((entry) => entry.line);
    const after = lines.indexOf("after");
    const first = lines.findIndex((line) => line.startsWith("\u0001"));
    return [
      lines.slice(0, first).join(""),
      lines.slice(first, after).join(""),
      ...lines.slice(after),
    ];
  };
  const expected = [long, escaped, "after"];
  expect(rejoin(await allLines(record, { services: ["setup"] }))).toEqual(
    expected,
  );
  expect(rejoin(await allLines(record))).toEqual(expected);
  const followed: TargetLogEntry[] = [];
  let cursor = before.cursor;
  for (let poll = 0; poll < 50 && followed.at(-1)?.line !== "after"; poll++) {
    const next = await readTargetLogs(record, cursor, 10000, {
      services: ["setup"],
    });
    followed.push(...next.entries);
    cursor = next.cursor;
  }
  expect(rejoin(followed)).toEqual(expected);
});

test("Service output keeps a character whole where a record is cut, on both streams, with and without a newline, and split across chunks", async () => {
  const root = await tempRoot("capture");
  const supervisor = createChildSupervisor({
    timing: createProcessTiming(),
    processInspection: createProcessInspection({
      run: runCommand,
      kill: platformKill,
    }),
    stateRoot: root,
  });
  supervisors.push(supervisor);
  const record = target(root);
  const atCut = "a".repeat(65_535) + "😀";
  const unterminated = "b".repeat(65_534) + "é" + "😀".repeat(20_000);
  const script = join(root, "service.ts");
  await writeFile(
    script,
    chunkedScript([
      { stream: "stdout", bytes: [...Buffer.from(atCut + "\n")] },
      ...byteByByte("stdout", "😀€\n"),
      { stream: "stderr", bytes: [...Buffer.from(unterminated)] },
    ]),
  );
  await supervisor.ensureRunning({
    key: "t:worker",
    componentName: "worker",
    command: [process.execPath, script],
    cwd: root,
    env: { PATH: process.env.PATH! },
    logRoot: record.logRoot,
    incarnation: "start-1",
  });
  const read = async () => {
    const entries = await allLines(record, { services: ["worker"] });
    const byStream = (stream: string) =>
      entries.filter((entry) => entry.stream === stream);
    return { entries, stdout: byStream("stdout"), stderr: byStream("stderr") };
  };
  let seen = await read();
  for (
    let wait = 0;
    wait < 200 &&
    seen.stderr.map((entry) => entry.line).join("") !== unterminated;
    wait++
  ) {
    await Bun.sleep(25);
    seen = await read();
  }
  for (const entry of seen.entries) {
    expect(entry.line.isWellFormed()).toBe(true);
    expect(Buffer.byteLength(entry.line)).toBeLessThanOrEqual(64 * 1024);
  }
  expect(seen.stdout.map((entry) => entry.line)).toEqual([
    "a".repeat(65_535),
    "😀",
    "😀€",
  ]);
  expect(seen.stderr.map((entry) => entry.line).join("")).toBe(unterminated);
  expect(seen.stderr.length).toBeGreaterThan(1);
});

test("a record a crash cut short does not swallow the next record written", async () => {
  const root = await tempRoot("torn");
  const record = target(root);
  await mkdir(record.logRoot, { recursive: true });
  const file = join(record.logRoot, "target.jsonl");
  const valid = (line: string) =>
    JSON.stringify({
      timestamp: "2026-10-01T00:00:01Z",
      component: "web",
      stream: "stdout",
      line,
    }) + "\n";
  await writeFile(file, valid("before") + '{"timestamp":"2026-10');
  await appendTargetLog(root, record.logRoot, valid("after"));
  const entries = await allLines(record);
  expect(entries.map((entry) => entry.line)).toEqual([
    "before",
    expect.stringMatching(/^Rig skipped an unreadable log record/),
    "after",
  ]);
  expect(await allLines(record, { services: ["web"] })).toMatchObject([
    { line: "before" },
    { line: "after" },
  ]);
  // Two writers that both ended the cut record leave an empty line, which is no record at all.
  await appendFile(file, '{"timestamp":"2026-10\n\n' + valid("last"));
  expect((await allLines(record)).map((entry) => entry.line)).toEqual([
    "before",
    expect.stringMatching(/^Rig skipped/),
    "after",
    expect.stringMatching(/^Rig skipped/),
    "last",
  ]);
});

test("a filter for a quiet Service among noisy ones passes over their records unparsed, first page and follow alike", async () => {
  const root = await tempRoot("sparse");
  const record = target(root);
  await mkdir(record.logRoot, { recursive: true });
  const file = join(record.logRoot, "target.jsonl");
  const line = (component: string, text: string) =>
    JSON.stringify({
      timestamp: "2026-10-01T00:00:00Z",
      component,
      stream: "stdout",
      line: text,
    }) + "\n";
  const noise = (count: number) => line("s0", "x".repeat(100)).repeat(count);
  // The quiet Service's one line is the oldest: older matches stay reachable.
  await writeFile(file, line("s1", "quiet") + noise(100_000));
  const parse = spyOn(JSON, "parse");
  try {
    const first = await readTargetLogs(record, undefined, 50, {
      services: ["s1"],
    });
    expect(first.entries.map((entry) => entry.line)).toEqual(["quiet"]);
    expect(parse.mock.calls.length).toBeLessThan(10);
    await appendFile(file, noise(20_000) + line("s1", "later"));
    parse.mockClear();
    const next = await readTargetLogs(record, first.cursor, 50, {
      services: ["s1"],
    });
    expect(next.entries.map((entry) => entry.line)).toEqual(["later"]);
    expect(parse.mock.calls.length).toBeLessThan(10);
    // With a since bound the noisy records are passed with the time read from their bytes, still unparsed.
    parse.mockClear();
    const since = await readTargetLogs(record, undefined, 50, {
      services: ["s1"],
      since: "2026-09-30T00:00:00Z",
    });
    expect(since.entries.map((entry) => entry.line)).toEqual([
      "quiet",
      "later",
    ]);
    expect(parse.mock.calls.length).toBeLessThan(10);
    // A component's name is matched whole, not as a prefix.
    expect(
      (await readTargetLogs(record, undefined, 50, { services: ["s"] }))
        .entries,
    ).toEqual([]);
  } finally {
    parse.mockRestore();
  }
});

test("a filtered read since a time still walks past late-written older records of its component while other components' current ones follow them", async () => {
  const root = await tempRoot("since-filter");
  const record = target(root);
  await mkdir(record.logRoot, { recursive: true });
  const at = (timestamp: string, component: string, text: string) =>
    JSON.stringify({ timestamp, component, stream: "stdout", line: text }) +
    "\n";
  const since = "2026-10-01T12:00:00.000Z";
  // A web record inside the window, then more than a window of web records timed an hour earlier (written late, as after
  // a sleep), each followed by a current record of another component.
  const late =
    at("2026-10-01T11:00:00.000Z", "web", "x".repeat(1000)) +
    at("2026-10-01T12:00:05.000Z", "worker", "busy");
  await writeFile(
    join(record.logRoot, "target.jsonl"),
    at("2026-10-01T12:00:01.000Z", "web", "current") + late.repeat(5000),
  );
  const web = async (filter: LogFilter) =>
    (await readTargetLogs(record, undefined, 10000, filter)).entries
      .filter((entry) => entry.component === "web")
      .map((entry) => entry.line);
  expect(await web({ since })).toEqual(["current"]);
  expect(await web({ since, services: ["web"] })).toEqual(["current"]);
  expect(await web({ since, services: ["web"], stream: "stdout" })).toEqual([
    "current",
  ]);
});
