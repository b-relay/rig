import { readFile } from "node:fs/promises";
import { z } from "zod";
import { RigError, errorMessage } from "../domain/errors";
import { describeInvalidDocument } from "../domain/invalid-document";

// The records Rig keeps for its Caddy under the Rig root (ADR 0014), as they are read back. Each holds the fields its
// readers use; a field an older rigd did not write is optional.

/** One of the owner's routes, or the dashboard's, as a generation recorded it (HostRoute). */
const hostRouteSchema = z.object({
  hostname: z.string().min(1),
  upstream: z.string().min(1).nullable(),
});
/** The dashboard's route as a generation recorded it (PublishedDashboard). */
const publishedDashboardSchema = z.object({
  domain: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable(),
});
/** A generation's `generation.json`: what it was built from. */
export const generationMetadataSchema = z.looseObject({
  id: z.string().min(1),
  ca: z.string().min(1),
  settings: z.string().min(1),
  // Checked by its readers against this Rig's proxy settings: settings another Rig accepted are no last-good, but they
  // do not make the record damaged.
  proxy: z.unknown().optional(),
  customRoutes: z.array(hostRouteSchema).optional(),
  dashboard: publishedDashboardSchema.nullable().optional(),
  ownerRoutesOnly: z.boolean().optional(),
  createdAt: z.string().min(1),
});
export type RecordedGeneration = z.infer<typeof generationMetadataSchema>;
/** `caddy/settings-rejected.json`: Host config Rig refused, while Host config still says it (RejectedSettings). */
export const rejectedSettingsSchema = z.object({
  settings: z.string().min(1),
  code: z.string().min(1),
  reason: z.string(),
  at: z.string().min(1),
});

/** The record at `path` checked against `schema`, or undefined when the file is absent. One that cannot be read, is not
 * JSON or does not match is refused as PROXY_STATE_CORRUPT, naming the file, what is wrong with it, and `repair`. */
export async function readProxyRecord<T>(
  path: string,
  schema: z.ZodType<T>,
  what: string,
  repair: string,
): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw corruptRecord(
      path,
      what,
      `cannot be read (${errorMessage(error)})`,
      repair,
    );
  }
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    throw corruptRecord(
      path,
      what,
      describeInvalidDocument(error, what),
      repair,
    );
  }
}
function corruptRecord(
  path: string,
  what: string,
  problem: string,
  repair: string,
): RigError {
  return new RigError(
    "PROXY_STATE_CORRUPT",
    `Rig cannot read ${what}.`,
    `${path} ${problem}. ${repair}`,
    { path },
  );
}
