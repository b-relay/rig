import { readFile, readlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  proxySettingsSchema,
  type ProxySettings,
} from "../config/proxy-schema";
import {
  generationFiles,
  proxyPaths,
  settingsDigest,
  type HostRoute,
} from "../domain/managed-proxy";

/** One generation as it was published: read from its own directory, never through the `current` link again, so a reader
 * that pins it sees one generation even while a publication switches the link. */
export interface PublishedGeneration {
  readonly id: string;
  /** Its copy of the route file. */
  readonly routes: string;
  /** The proxy settings it was accepted with. A generation without them (none was ever released) is no last-good: what it
   * serves is described as before the first generation. */
  readonly proxy?: ProxySettings;
  /** The owner's `proxy.routes` it serves. */
  readonly customRoutes: readonly HostRoute[];
  /** Its adapted JSON: what a Caddy serving it reports at GET /config/; absent when unreadable. */
  readonly adapted?: unknown;
}
/** The generation `current` names now, resolved once; undefined before the first. */
export async function currentGeneration(
  root: string,
): Promise<PublishedGeneration | undefined> {
  const link = proxyPaths(root).current;
  const target = await readlink(link).catch(() => undefined);
  if (!target) return undefined;
  const directory = target.startsWith("/")
    ? target
    : join(dirname(link), target);
  const files = generationFiles(directory);
  const metadata = await readFile(files.metadata, "utf8")
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>);
  const proxy = proxySettingsSchema.safeParse(metadata.proxy);
  const customRoutes = Array.isArray(metadata.customRoutes)
    ? metadata.customRoutes.flatMap((entry: unknown) => {
        const route = entry as Partial<HostRoute> | null;
        return typeof route?.hostname === "string" &&
          typeof route.upstream === "string"
          ? [{ hostname: route.hostname, upstream: route.upstream }]
          : [];
      })
    : [];
  const adapted = await readFile(files.adapted, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  return {
    id: basename(directory),
    routes: await readFile(files.routes, "utf8").catch(() => ""),
    ...(adapted !== undefined ? { adapted } : {}),
    ...(proxy.success ? { proxy: proxy.data } : {}),
    customRoutes,
  };
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
    (field) => !Bun.deepEquals(accepted[field], requested[field]),
  );
  const rejection = await readFile(proxyPaths(root).rejectedSettings, "utf8")
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch(() => undefined);
  if (rejection?.settings === settingsDigest(requested))
    return {
      fields,
      reason: String(rejection.reason),
      ...(typeof rejection.code === "string" ? { code: rejection.code } : {}),
    };
  return { fields, reason: "Not applied yet: run rig proxy reload." };
}
