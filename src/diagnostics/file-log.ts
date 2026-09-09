import { Database } from "bun:sqlite";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readdir,
  rm,
  link,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
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
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        release = await acquireLock(lock);
        const timestamp = options.now().toISOString();
        await rotateDiagnostic(
          path,
          directory,
          options.source,
          timestamp.slice(0, 10),
        );
        await appendFile(
          path,
          `${JSON.stringify(diagnosticRecord(entry, options.source, timestamp))}\n`,
          { mode: 0o600 },
        );
        await chmod(path, 0o600);
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
  const database = new Database(path, { create: true });
  try {
    await chmod(path, 0o600);
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
async function rotateDiagnostic(
  path: string,
  directory: string,
  source: string,
  today: string,
): Promise<void> {
  const previousDay = await firstRecordDay(path);
  if (!previousDay || previousDay >= today) return;
  const identity = await stat(path, { bigint: true });
  const canonical = join(directory, `${source}-${previousDay}.jsonl`);
  const archived = await stat(canonical, { bigint: true }).catch((error) => {
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
    const existing = await stat(archive, { bigint: true });
    if (existing.ino !== identity.ino || existing.dev !== identity.dev)
      throw new Error("Diagnostic archive identity conflict.");
  }
  await chmod(archive, 0o600);
  // If a writer dies between link and unlink, the next writer recognizes the same inode and completes rotation.
  await rm(path);
}
/** Normal appends inspect at most 4096 bytes, regardless of current log size. */
async function firstRecordDay(path: string): Promise<string | undefined> {
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
    const text = buffer.subarray(0, bytesRead).toString("utf8"),
      newline = text.indexOf("\n");
    if (newline < 0) return undefined;
    try {
      const first = JSON.parse(text.slice(0, newline)) as {
        timestamp?: unknown;
      };
      return typeof first.timestamp === "string" &&
        /^\d{4}-\d{2}-\d{2}T/.test(first.timestamp)
        ? first.timestamp.slice(0, 10)
        : undefined;
    } catch {
      return undefined;
    }
  } finally {
    await file.close();
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
