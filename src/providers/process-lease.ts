import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

/** What a child supervisor records when it spawns a process group: enough to recognise that process again, and never a
 * reused pid, after the supervisor itself is gone. */
export const processLeaseSchema = z.object({
  key: z.string().describe("Stable component ownership key."),
  pid: z
    .number()
    .int()
    .min(2)
    .describe(
      "Owned process group leader; the group id equals this PID, so the group can outlive the leader.",
    ),
  identity: z
    .string()
    .length(64)
    .describe("Digest of immutable process birth time and PID."),
  incarnation: z
    .string()
    .optional()
    .describe(
      "The start that produced this process; absent on a lease written before starts were named.",
    ),
});
export type ProcessLease = z.infer<typeof processLeaseSchema>;

/** Where a child supervisor whose state lives in `stateRoot` keeps its leases. */
export function processLeaseRoot(stateRoot: string): string {
  return join(stateRoot, "process-leases");
}
/** The lease a child supervisor whose state lives in `stateRoot` writes for `key`. */
export function processLeasePath(stateRoot: string, key: string): string {
  return join(
    processLeaseRoot(stateRoot),
    `${createHash("sha256").update(key).digest("hex")}.json`,
  );
}
