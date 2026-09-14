import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OperationRecord } from "../domain/runtime";
import { RigError } from "../domain/errors";
import { processStartTime, recordedProcess } from "../daemon/process-identity";

/** A lock whose holder cannot be read is stale once older than this. */
const LOCK_STALE_MS = 60_000;
const holderSchema = z.object({
  pid: z.number().int().positive().describe("Process holding the lock."),
  startedAt: z
    .string()
    .min(1)
    .optional()
    .describe("Start time of that process, which tells a reused pid apart."),
});
/** Takes the journal lock, reclaiming one whose writer has exited, was
 * replaced, or left no readable holder more than a minute ago. A lock held by
 * a live process, or an unreadable one that is still fresh, is refused with
 * the path named so an operator can recover. */
async function acquireLock(
  lockPath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  const holder = {
    pid: process.pid,
    ...(await processStartTime(process.pid).then((startedAt) =>
      startedAt ? { startedAt } : {},
    )),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify(holder));
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const recorded = await readFile(lockPath, "utf8")
      .then((text) => holderSchema.parse(JSON.parse(text)))
      .catch(() => undefined);
    if (recorded) {
      const liveness = await recordedProcess(recorded);
      if (liveness === "running" || liveness === "unverified")
        throw new RigError(
          "ADMIN_ACTIVITY_LOCKED",
          "Another daemon administration is recording activity.",
          `The activity journal lock at ${lockPath} is held by pid ${recorded.pid}, which is alive. Wait for it; if no rigd administration is running, remove ${lockPath} and retry.`,
          { lockPath, pid: recorded.pid },
        );
    } else {
      const age =
        Date.now() -
        ((await stat(lockPath).catch(() => undefined))?.mtimeMs ?? Date.now());
      if (age < LOCK_STALE_MS)
        throw new RigError(
          "ADMIN_ACTIVITY_LOCKED",
          "Another daemon administration is recording activity.",
          `The activity journal lock at ${lockPath} was taken less than a minute ago by a writer that recorded no pid. Wait for it; if no rigd administration is running, remove ${lockPath} and retry.`,
          { lockPath },
        );
    }
    await rm(lockPath, { force: true });
  }
  throw new RigError(
    "ADMIN_ACTIVITY_LOCKED",
    "Another daemon administration is recording activity.",
    `The activity journal lock at ${lockPath} was taken again while it was being reclaimed. Retry.`,
    { lockPath },
  );
}

const entrySchema = z
  .object({
    id: z.string().min(1).describe("Operation correlation identity."),
    action: z
      .enum(["daemon-install", "daemon-uninstall"])
      .describe("Explicit daemon administration action."),
    outcome: z
      .enum(["installed", "uninstalled", "unchanged", "failed"])
      .describe("Observed final administration outcome."),
    occurredAt: z
      .string()
      .datetime({ offset: true })
      .describe("Final outcome timestamp."),
    message: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Safe failure code; excludes raw exception and environment values.",
      ),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      (entry.action === "daemon-install" && entry.outcome === "uninstalled") ||
      (entry.action === "daemon-uninstall" && entry.outcome === "installed")
    )
      context.addIssue({
        code: "custom",
        message: "Administration action and outcome disagree.",
      });
  });
export interface AdminActivityInput {
  id?: string;
  action: "daemon-install" | "daemon-uninstall";
  outcome: "installed" | "uninstalled" | "unchanged" | "failed";
  message?: string;
}
export interface AdminActivityJournal {
  read(): Promise<OperationRecord[]>;
  append(input: AdminActivityInput): Promise<{ warning?: string }>;
}
/** Admin-only append journal. Runtime may read it after the daemon has stopped without owning writes.
 * Invalid history is preserved and rejected; evidence failure never replaces an administration outcome.
 */
export function createAdminActivityJournal(options: {
  root: string;
  now(): string;
  id(): string;
}): AdminActivityJournal {
  const directory = join(options.root, "runtime"),
    path = join(directory, "admin-activity.jsonl");
  const read = async (): Promise<OperationRecord[]> => {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RigError(
        "ADMIN_ACTIVITY_READ",
        "Daemon activity history could not be read.",
        "Inspect the private activity journal permissions.",
      );
    }
    try {
      if (raw && !raw.endsWith("\n")) throw Error("incomplete entry");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => entrySchema.parse(JSON.parse(line)));
    } catch {
      throw new RigError(
        "ADMIN_ACTIVITY_CORRUPT",
        "Daemon activity history is invalid.",
        "Preserve the journal and restore verified activity evidence before retrying.",
      );
    }
  };
  return {
    read,
    async append(input) {
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      const lockPath = `${path}.lock`;
      try {
        const entry = entrySchema.parse({
          ...input,
          id: input.id ?? options.id(),
          occurredAt: options.now(),
        });
        await mkdir(directory, { recursive: true, mode: 0o700 });
        lock = await acquireLock(lockPath);
        await read();
        const file = await open(path, "a", 0o600);
        try {
          await file.chmod(0o600);
          await file.writeFile(JSON.stringify(entry) + "\n");
          await file.sync();
        } finally {
          await file.close();
        }
        return {};
      } catch (error) {
        return {
          warning: `Daemon activity could not be recorded; the administration outcome is unchanged. ${
            error instanceof RigError
              ? error.hint
              : `Inspect ${path} and ${lockPath}.`
          }`,
        };
      } finally {
        if (lock) {
          await lock.close().catch(() => {});
          await rm(lockPath, { force: true }).catch(() => {});
        }
      }
    },
  };
}
