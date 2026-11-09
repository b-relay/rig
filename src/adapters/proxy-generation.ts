import { readFile, readlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  proxySettingsSchema,
  type ProxySettings,
} from "../config/proxy-schema";
import type { z } from "zod";
import { caddyConfigSchema } from "../domain/caddy-config";
import { RigError } from "../domain/errors";
import {
  CADDY_IGNORED_FIELDS,
  generationFiles,
  proxyPaths,
  renderedWildcards,
  settingsDigest,
  type HostRoute,
  type PublishedDashboard,
} from "../domain/managed-proxy";
import {
  generationMetadataSchema,
  readProxyRecord,
  rejectedSettingsSchema,
} from "../providers/proxy-records";

/** One generation as it was published: read from its own directory, never through the `current` link again, so a reader
 * that pins it sees one generation even while a publication switches the link. */
export interface PublishedGeneration {
  readonly id: string;
  /** Its copy of the route file. */
  readonly routes: string;
  /** The wildcard subjects its main file asks for. */
  readonly wildcards: readonly string[];
  /** The proxy settings it was accepted with. A generation without them (none was ever released) is no last-good: what it
   * serves is described as before the first generation. */
  readonly proxy?: ProxySettings;
  /** The digest (`settingsDigest`) of the settings it was accepted with, also when this Rig cannot read them; absent with its
   * record. */
  readonly settings?: string;
  /** The owner's `proxy.routes` it serves, and the dashboard's route. */
  readonly customRoutes: readonly HostRoute[];
  /** The dashboard's route it serves, as rigd asked for it; null for none. Absent from an older rigd's generations. */
  readonly dashboard?: PublishedDashboard | null;
  /** Its adapted JSON: what a Caddy serving it reports at GET /config/, and what Caddy starts from; absent when damaged. */
  readonly adapted?: unknown;
  /** Why its record (`metadata`, which says what settings it was accepted with) or its adapted JSON (`adapted`) cannot be
   * used: PROXY_STATE_CORRUPT naming the file, what is wrong with it, missing included, and its repair. Absent when both can.
   * The evidence the damaged file held is absent too. */
  readonly damaged?: {
    readonly metadata?: RigError;
    readonly adapted?: RigError;
  };
}
/** The generation `current` names now, resolved once; undefined before the first. Its record and adapted JSON are read as
 * Rig's Caddy reads them (`generationMetadataSchema`, `caddyConfigSchema`); one that is missing or damaged is no evidence,
 * and `damaged` says why. */
export async function currentGeneration(
  root: string,
): Promise<PublishedGeneration | undefined> {
  const link = proxyPaths(root).current;
  const target = await readlink(link).catch(() => undefined);
  if (!target) return undefined;
  const directory = target.startsWith("/")
    ? target
    : join(dirname(link), target);
  const id = basename(directory);
  const files = generationFiles(directory);
  const metadata = await generationRecord(
    files.metadata,
    generationMetadataSchema,
    `the record of Caddy generation ${id}`,
  );
  const adapted = await generationRecord(
    files.adapted,
    caddyConfigSchema,
    `the configuration Caddy generation ${id} was validated as`,
  );
  const recorded = metadata instanceof RigError ? undefined : metadata;
  const proxy = proxySettingsSchema.safeParse(recorded?.proxy);
  const damaged = {
    ...(metadata instanceof RigError ? { metadata } : {}),
    ...(adapted instanceof RigError ? { adapted } : {}),
  };
  return {
    id,
    routes: await readFile(files.routes, "utf8").catch(() => ""),
    wildcards: renderedWildcards(
      await readFile(files.main, "utf8").catch(() => ""),
    ),
    ...(adapted instanceof RigError ? {} : { adapted }),
    ...(proxy.success ? { proxy: proxy.data } : {}),
    ...(recorded ? { settings: recorded.settings } : {}),
    customRoutes: recorded?.customRoutes ?? [],
    ...(recorded?.dashboard !== undefined
      ? { dashboard: recorded.dashboard }
      : {}),
    ...(Object.keys(damaged).length ? { damaged } : {}),
  };
}
/** A generation file every generation Rig publishes holds, checked against `schema`; PROXY_STATE_CORRUPT when it is missing,
 * unreadable or of the wrong shape, with the repair that builds a complete generation again. */
async function generationRecord<T>(
  path: string,
  schema: z.ZodType<T>,
  what: string,
): Promise<T | RigError> {
  const rebuild =
    "run rig proxy reload: Rig builds a new generation from Host config.";
  try {
    return (
      (await readProxyRecord(
        path,
        schema,
        what,
        `Delete it, then ${rebuild}`,
      )) ??
      new RigError(
        "PROXY_STATE_CORRUPT",
        `Rig cannot read ${what}.`,
        `${path} is missing. To make the generation complete again, ${rebuild}`,
        { path },
      )
    );
  } catch (error) {
    if (error instanceof RigError) return error;
    throw error;
  }
}
/** Host config's proxy section that Caddy does not serve: which of its parts differ from the accepted settings, and why,
 * when Rig refused them. */
export interface PendingSettings {
  /** Top-level `proxy` fields that differ from what is served, such as `routes` or `tls`; empty when Host config cannot be
   * read at all. */
  readonly fields: readonly string[];
  /** Why Rig refused them, or that they have not been applied yet. */
  readonly reason: string;
  /** The refusal's code, when Rig refused them. */
  readonly code?: string;
}
/** What of `requested` (Host config now, or the error reading it) the settings `accepted` (a pinned generation's) do not
 * say; undefined when they say exactly that, or when nothing was accepted yet. */
export async function pendingSettings(
  root: string,
  requested: ProxySettings | Error,
  accepted: ProxySettings | undefined,
): Promise<PendingSettings | undefined> {
  if (requested instanceof Error)
    return {
      fields: [],
      reason: `Host config cannot be read, so Caddy keeps the settings it last accepted: ${requested.message}`,
      ...("code" in requested && typeof requested.code === "string"
        ? { code: requested.code }
        : {}),
    };
  if (!accepted) return undefined;
  if (settingsDigest(accepted) === settingsDigest(requested)) return undefined;
  const fields = (Object.keys(requested) as (keyof ProxySettings)[]).filter(
    (field) =>
      !CADDY_IGNORED_FIELDS.has(field) &&
      !Bun.deepEquals(accepted[field], requested[field]),
  );
  const rejection = await readProxyRecord(
    proxyPaths(root).rejectedSettings,
    rejectedSettingsSchema,
    "why it refused the proxy section of Host config",
    "Delete it, then run rig proxy reload: Rig records the refusal again if it still refuses them.",
  );
  if (rejection?.settings === settingsDigest(requested))
    return { fields, reason: rejection.reason, code: rejection.code };
  return { fields, reason: "Not applied yet: run rig proxy reload." };
}
