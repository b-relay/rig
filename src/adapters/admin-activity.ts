import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OperationRecord } from "../domain/runtime";
import { RigError } from "../domain/errors";

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
        lock = await open(lockPath, "wx", 0o600);
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
      } catch {
        return {
          warning:
            "Daemon activity could not be recorded; the administration outcome is unchanged.",
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
