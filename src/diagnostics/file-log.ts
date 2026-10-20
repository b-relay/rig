import { boundedEvidence, failureCategories } from "../domain/errors";
import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { lstat, open, readdir, rm, link } from "node:fs/promises";
import { join } from "node:path";
import {
  appendInPrivateDirectory,
  preparePrivateStoreSync,
  privateDirectory,
} from "../providers/private-files";
import type { DiagnosticEntry, DiagnosticLog } from "./types";

export interface FileDiagnosticOptions {
  root: string;
  source: "rig" | "rigd";
  now: () => Date;
  retentionDays?: number;
  level?: "debug" | "info" | "warn" | "error";
}
const metadataKeys = [
  "operationId",
  "action",
  "project",
  "target",
  "outcome",
  "code",
] as const;
const dayMilliseconds = 86_400_000;

/** A closed metadata policy prevents accidentally serializing errors or configurations. */
export function diagnosticRecord(
  entry: DiagnosticEntry,
  source: "rig" | "rigd",
  timestamp: string,
): Record<string, string> {
  const record: Record<string, string> = {
    timestamp,
    source,
    level:
      entry.level === "debug" ||
      entry.level === "error" ||
      entry.level === "warn"
        ? entry.level
        : "info",
    event: safeMetadata(entry.event) ?? "diagnostic.invalid-event",
  };
  for (const key of metadataKeys) {
    const value = safeMetadata(entry[key]);
    if (value !== undefined) record[key] = value;
  }
  for (const key of ["primaryCause", "recoveryCause"] as const) {
    const value = entry[key];
    if (
      typeof value === "string" &&
      failureCategories.some((category) => category === value)
    )
      record[key] = value;
  }
  if (typeof entry.evidence === "string") {
    const evidence = boundedEvidence(entry.evidence);
    if (evidence !== undefined) record.evidence = evidence;
  }
  return record;
}
function safeMetadata(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)
    ? value
    : undefined;
}
function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** Filesystem Adapter; root and clock are acquired by the process entrypoint. */
export function createFileDiagnosticLog(
  options: FileDiagnosticOptions,
): DiagnosticLog {
  const directory = join(options.root, "logs", options.source);
  const path = join(directory, `${options.source}.jsonl`);
  const lock = join(directory, ".write-lock.sqlite");
  return {
    async record(entry) {
      const priorities = { debug: 0, info: 1, warn: 2, error: 3 };
      if (
        priorities[entry.level ?? "info"] < priorities[options.level ?? "info"]
      )
        return {};
      let release: (() => void) | undefined;
      try {
        await privateDirectory(options.root, directory);
        release = await acquireLock(lock);
        const timestamp = options.now().toISOString();
        await rotateDiagnostic(
          path,
          directory,
          options.source,
          timestamp.slice(0, 10),
        );
        await appendRecord(
          path,
          JSON.stringify(diagnosticRecord(entry, options.source, timestamp)),
        );
        await pruneDiagnostics(
          directory,
          options.source,
          timestamp.slice(0, 10),
          options.retentionDays ?? 14,
        );
        return { path };
      } catch {
        return { error: "Diagnostic evidence could not be recorded." };
      } finally {
        try {
          release?.();
        } catch {
          /* Logging cleanup cannot replace the command outcome. */
        }
      }
    },
  };
}

/** SQLite owns a kernel-released write lock; a killed writer leaves no stale lease to reclaim. */
async function acquireLock(path: string): Promise<() => void> {
  // SQLite opens the lock and its journal itself, following links: each is made or checked first, never through one.
  preparePrivateStoreSync(path, [
    `${path}-journal`,
    `${path}-wal`,
    `${path}-shm`,
  ]);
  const database = new Database(path, { create: true });
  try {
    database.exec("PRAGMA busy_timeout=0");
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        database.exec("BEGIN IMMEDIATE");
        return () => {
          try {
            database.exec("ROLLBACK");
          } finally {
            database.close();
          }
        };
      } catch (error) {
        if (!hasCode(error, "SQLITE_BUSY") && !hasCode(error, "SQLITE_LOCKED"))
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Diagnostic writer is busy.");
  } catch (error) {
    database.close();
    throw error;
  }
}
/** A record killed mid-write leaves a line without its newline; the next record starts on its own line rather than gluing onto it. */
async function appendRecord(path: string, record: string): Promise<void> {
  const separator = (await endsWithNewline(path)) ? "" : "\n";
  await appendInPrivateDirectory(path, `${separator}${record}\n`);
}
async function endsWithNewline(path: string): Promise<boolean> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await file.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await file.close();
  }
}
async function rotateDiagnostic(
  path: string,
  directory: string,
  source: string,
  today: string,
): Promise<void> {
  // Judged before anything is read or moved: a link or anything but a regular file is never rotated, and the record that
  // follows refuses it too.
  const identity = await lstat(path, { bigint: true }).catch((error) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (identity === undefined) return;
  if (!identity.isFile()) throw new Error("Diagnostic log is not a file.");
  const previousDay = await segmentDay(path);
  if (!previousDay || previousDay >= today) return;
  const canonical = join(directory, `${source}-${previousDay}.jsonl`);
  const archived = await lstat(canonical, { bigint: true }).catch((error) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  const archive =
    archived && archived.ino !== identity.ino
      ? join(directory, `${source}-${previousDay}-${identity.ino}.jsonl`)
      : canonical;
  try {
    await link(path, archive);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  // The archive is made private through a descriptor proven to be the active file's own inode, never through a link.
  const file = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat({ bigint: true });
    if (opened.ino !== identity.ino || opened.dev !== identity.dev)
      throw new Error("Diagnostic archive identity conflict.");
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
  // If a writer dies between link and unlink, the next writer recognizes the same inode and completes rotation.
  await rm(path);
}
/** The day an active segment belongs to: that of its first complete record within the leading 4096 bytes,
 * or, when a partial or corrupt head hides every record, the day the file was created. */
async function segmentDay(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(4096),
      { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    for (const line of lines.slice(0, -1)) {
      const day = recordDay(line);
      if (day) return day;
    }
    const { birthtime, mtime } = await file.stat();
    const created = birthtime.getTime() > 0 ? birthtime : mtime;
    return created.toISOString().slice(0, 10);
  } finally {
    await file.close();
  }
}
function recordDay(line: string): string | undefined {
  try {
    const record = JSON.parse(line) as { timestamp?: unknown };
    return typeof record.timestamp === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(record.timestamp)
      ? record.timestamp.slice(0, 10)
      : undefined;
  } catch {
    return undefined;
  }
}
async function pruneDiagnostics(
  directory: string,
  source: string,
  today: string,
  retentionDays: number,
): Promise<void> {
  const oldest = new Date(
    Date.parse(`${today}T00:00:00Z`) - (retentionDays - 1) * dayMilliseconds,
  )
    .toISOString()
    .slice(0, 10);
  const ownedName = new RegExp(
    `^${source}-(\\d{4}-\\d{2}-\\d{2})(?:-\\d+)?\\.jsonl$`,
  );
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const date = ownedName.exec(entry.name)?.[1];
    if (entry.isFile() && date && date < oldest)
      await rm(join(directory, entry.name));
  }
}
