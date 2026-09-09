import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileDiagnosticLog } from "./file-log";

test("writes private correlated diagnostic metadata and rejects arbitrary payload fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-diagnostics-"));
  try {
    const log = createFileDiagnosticLog({
      root,
      source: "rig",
      now: () => new Date("2026-09-09T12:00:00Z"),
    });
    const result = await log.record({
      event: "command.completed",
      action: "up",
      operationId: "op-123",
      outcome: "started",
      token: "secret-token",
      env: { KEY: "secret-env" },
      config: { name: "secret-config" },
      command: "secret-command",
      error: new Error("secret-error"),
    } as any);
    expect(result.path).toBe(join(root, "logs/rig/rig.jsonl"));
    const text = await readFile(result.path!, "utf8");
    expect(JSON.parse(text)).toEqual({
      timestamp: "2026-09-09T12:00:00.000Z",
      source: "rig",
      level: "info",
      event: "command.completed",
      operationId: "op-123",
      action: "up",
      outcome: "started",
    });
    expect(text).not.toContain("secret");
    expect((await stat(result.path!)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rotates each source daily and retains only its own fourteen-day diagnostic window", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-diagnostics-"));
  const { mkdir, writeFile, readdir } = await import("node:fs/promises");
  let now = new Date("2026-09-08T23:59:59Z");
  try {
    const directory = join(root, "logs/rig");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "rig-2026-08-25.jsonl"), "old\n");
    await writeFile(join(directory, "rig-2026-08-27.jsonl"), "retained\n");
    await writeFile(
      join(directory, "application-2026-01-01.jsonl"),
      "untouched\n",
    );
    const log = createFileDiagnosticLog({
      root,
      source: "rig",
      now: () => now,
    });
    await log.record({ event: "command.started" });
    now = new Date("2026-09-09T00:00:01Z");
    await log.record({ event: "command.completed" });
    const names = await readdir(directory);
    expect(names).toContain("rig-2026-09-08.jsonl");
    expect(names).not.toContain("rig-2026-08-25.jsonl");
    expect(names).toContain("rig-2026-08-27.jsonl");
    expect(names).toContain("application-2026-01-01.jsonl");
    expect(await readFile(join(directory, "rig.jsonl"), "utf8")).toContain(
      "command.completed",
    );
    expect(await readFile(join(directory, "rig.jsonl"), "utf8")).not.toContain(
      "command.started",
    );
    expect(
      await readFile(join(directory, "rig-2026-09-08.jsonl"), "utf8"),
    ).toContain("command.started");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent writers serialize rotation without lost or duplicated records", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-diagnostics-"));
  try {
    const previous = createFileDiagnosticLog({
      root,
      source: "rig",
      now: () => new Date("2026-09-08T12:00:00Z"),
    });
    await previous.record({ event: "previous" });
    const writers = Array.from({ length: 12 }, () =>
      createFileDiagnosticLog({
        root,
        source: "rig",
        now: () => new Date("2026-09-09T12:00:00Z"),
      }),
    );
    const results = await Promise.all(
      writers.map((log, index) =>
        log.record({ event: "command.completed", operationId: `op-${index}` }),
      ),
    );
    expect(
      results.every((result) => Boolean(result.path) && !result.error),
    ).toBe(true);
    const current = (await readFile(join(root, "logs/rig/rig.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(current).toHaveLength(12);
    expect(new Set(current.map((record) => record.operationId)).size).toBe(12);
    const archive = (
      await readFile(join(root, "logs/rig/rig-2026-09-08.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(archive).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unwritable destination reports evidence unavailable without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-diagnostics-"));
  const { writeFile } = await import("node:fs/promises");
  try {
    await writeFile(join(root, "logs"), "occupied");
    const log = createFileDiagnosticLog({
      root,
      source: "rig",
      now: () => new Date("2026-09-09T12:00:00Z"),
    });
    expect(await log.record({ event: "command.failed" })).toEqual({
      error: "Diagnostic evidence could not be recorded.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("host verbosity and retention policy control admitted levels and archive lifetime", async () => {
  const { mkdir, writeFile, readdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "rig-diagnostic-policy-"));
  try {
    const directory = join(root, "logs/rig");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "rig-2026-09-07.jsonl"), "keep\n");
    await writeFile(join(directory, "rig-2026-09-06.jsonl"), "prune\n");
    const log = createFileDiagnosticLog({
      root,
      source: "rig",
      now: () => new Date("2026-09-09T12:00:00Z"),
      retentionDays: 3,
      level: "warn",
    });
    expect(await log.record({ event: "ignored", level: "info" })).toEqual({});
    await log.record({ event: "warning", level: "warn" });
    const names = await readdir(directory);
    expect(names).toContain("rig-2026-09-07.jsonl");
    expect(names).not.toContain("rig-2026-09-06.jsonl");
    const debug = createFileDiagnosticLog({
      root,
      source: "rig",
      now: () => new Date("2026-09-09T12:00:00Z"),
      level: "debug",
    });
    await debug.record({ event: "trace", level: "debug" });
    const records = (await readFile(join(directory, "rig.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => [record.event, record.level])).toEqual([
      ["warning", "warn"],
      ["trace", "debug"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a writer killed inside its critical section does not disable later diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-diagnostic-crash-"));
  const { resolve } = await import("node:path");
  const script = `import {createFileDiagnosticLog} from ${JSON.stringify(resolve("src/diagnostics/file-log.ts"))};import{writeSync}from'node:fs';await createFileDiagnosticLog({root:${JSON.stringify(root)},source:'rig',now:()=>{writeSync(1,'locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return new Date()}}).record({event:'interrupted'});`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const ready = await Promise.race([
      reader.read(),
      Bun.sleep(2000).then(() => {
        throw new Error("Writer did not enter its critical section");
      }),
    ]);
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
    const result = await createFileDiagnosticLog({
      root,
      source: "rig",
      now: () => new Date("2026-09-09T12:00:00Z"),
    }).record({ event: "recovered" });
    expect(result.error).toBeUndefined();
    expect(await readFile(result.path!, "utf8")).toContain("recovered");
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 8000);
test("rotation preserves an existing dated archive and a large active segment without merging or losing evidence", async () => {
  const { mkdir, writeFile, readdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "rig-diagnostic-collision-"));
  try {
    const directory = join(root, "logs/rig");
    await mkdir(directory, { recursive: true });
    const archived =
      JSON.stringify({ timestamp: "2026-09-08T10:00:00Z", event: "earlier" }) +
      "\n";
    const active =
      JSON.stringify({ timestamp: "2026-09-08T11:00:00Z", event: "later" }) +
      "\n" +
      "large-evidence\n".repeat(100000);
    await writeFile(join(directory, "rig-2026-09-08.jsonl"), archived);
    await writeFile(join(directory, "rig.jsonl"), active);
    const result = await createFileDiagnosticLog({
      root,
      source: "rig",
      now: () => new Date("2026-09-09T12:00:00Z"),
    }).record({ event: "today" });
    expect(result.error).toBeUndefined();
    expect(
      (await readFile(join(directory, "rig-2026-09-08.jsonl"), "utf8")) ===
        archived,
    ).toBe(true);
    const segments = (await readdir(directory)).filter((name) =>
      name.startsWith("rig-2026-09-08-"),
    );
    expect(segments).toHaveLength(1);
    expect(
      (await readFile(join(directory, segments[0]!), "utf8")) === active,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("an interrupted archive handoff completes without duplicating the previous segment", async () => {
  const { mkdir, writeFile, link } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "rig-diagnostic-handoff-"));
  try {
    const directory = join(root, "logs/rig");
    await mkdir(directory, { recursive: true });
    const previous =
      JSON.stringify({ timestamp: "2026-09-08T11:00:00Z", event: "once" }) +
      "\n";
    const current = join(directory, "rig.jsonl"),
      archive = join(directory, "rig-2026-09-08.jsonl");
    await writeFile(current, previous);
    await link(current, archive);
    const result = await createFileDiagnosticLog({
      root,
      source: "rig",
      now: () => new Date("2026-09-09T12:00:00Z"),
    }).record({ event: "today" });
    expect(result.error).toBeUndefined();
    expect(await readFile(archive, "utf8")).toBe(previous);
    expect((await readFile(current, "utf8")).includes("once")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
