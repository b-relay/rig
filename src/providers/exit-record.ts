import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { replacePrivateFile } from "./private-files";
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
/** Whoever holds the child handle when the process ends writes how it ended; the record is replaced whole. `stateRoot` is the
 * Rig root `root` or a directory inside it. */
export async function writeExitRecord(
  stateRoot: string,
  record: ExitRecord,
  root = stateRoot,
): Promise<void> {
  await replacePrivateFile(
    root,
    exitPath(stateRoot, record.key),
    JSON.stringify(record),
  );
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
/** What a capture wrapper's own end says about its application's, when the application's record is missing. A signal or a
 * non-zero code does: the wrapper ends by the signal that stopped it, or mirrors its application's failure. Code 0 does not,
 * because a wrapper from before wrappers ended by their signal also exits 0 after an outside SIGTERM, and a wrapper whose
 * application exited 0 by itself has already written that application's record. */
export function wrapperExitEvidence(exit: {
  exitCode?: number;
  signal?: string;
}): { exitCode: number } | { signal: string } | undefined {
  if (exit.signal !== undefined) return { signal: exit.signal };
  if (exit.exitCode !== undefined && exit.exitCode !== 0)
    return { exitCode: exit.exitCode };
  return undefined;
}
/** The exit evidence a stopped observation carries. */
export function exitEvidence(record: ExitRecord | undefined):
  | {
      incarnation: string;
      exitCode?: number;
      signal?: string;
      exitedAt: string;
    }
  | undefined {
  if (!record) return undefined;
  return {
    incarnation: record.incarnation,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.signal === undefined ? {} : { signal: record.signal }),
    exitedAt: record.at,
  };
}
