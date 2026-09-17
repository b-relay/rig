import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
const exitRecordSchema = z.object({
  key: z.string().min(1).describe("Stable component ownership key."),
  incarnation: z
    .string()
    .min(1)
    .describe("The start whose process this exit ended."),
  exitCode: z
    .number()
    .int()
    .optional()
    .describe("Exit code, when the process exited by itself."),
  signal: z
    .string()
    .optional()
    .describe("Signal that ended the process, when one did."),
  at: z.string().describe("When the exit was seen."),
});
export type ExitRecord = z.infer<typeof exitRecordSchema>;
const exitPath = (stateRoot: string, key: string) =>
  join(
    stateRoot,
    "process-exits",
    `${createHash("sha256").update(key).digest("hex")}.json`,
  );
/** Whoever holds the child handle when the process ends writes how it ended; the record is replaced whole. */
export async function writeExitRecord(
  stateRoot: string,
  record: ExitRecord,
): Promise<void> {
  const path = exitPath(stateRoot, record.key);
  await mkdir(join(stateRoot, "process-exits"), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
/** The recorded exit of `key`, or nothing when none was recorded or it cannot be read: an unreadable record proves nothing. */
export async function readExitRecord(
  stateRoot: string,
  key: string,
): Promise<ExitRecord | undefined> {
  try {
    const record = exitRecordSchema.parse(
      JSON.parse(await readFile(exitPath(stateRoot, key), "utf8")),
    );
    return record.key === key ? record : undefined;
  } catch {
    return undefined;
  }
}
export async function removeExitRecord(
  stateRoot: string,
  key: string,
): Promise<void> {
  await rm(exitPath(stateRoot, key), { force: true });
}
/** The exit evidence a stopped observation carries. */
export function exitEvidence(
  record: ExitRecord | undefined,
): { incarnation: string; exitCode?: number; signal?: string } | undefined {
  if (!record) return undefined;
  return {
    incarnation: record.incarnation,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.signal === undefined ? {} : { signal: record.signal }),
  };
}
