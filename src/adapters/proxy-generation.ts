import { readFile } from "node:fs/promises";
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

/** What the current generation was built from, as its metadata recorded it; undefined before the first generation. */
async function currentMetadata(
  root: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(
        generationFiles(proxyPaths(root).current).metadata,
        "utf8",
      ),
    );
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
/** The proxy settings Caddy was last given and accepted: the current generation's. What is served (ports, CA, certificates)
 * is described from these, never from Host config, which may hold settings Rig refused or has not applied yet. */
export async function acceptedProxySettings(
  root: string,
): Promise<ProxySettings | undefined> {
  const parsed = proxySettingsSchema.safeParse(
    (await currentMetadata(root))?.proxy,
  );
  return parsed.success ? parsed.data : undefined;
}
/** The owner's `proxy.routes` the current generation serves; none before the first generation. */
export async function currentCustomRoutes(root: string): Promise<HostRoute[]> {
  const routes = (await currentMetadata(root))?.customRoutes;
  return Array.isArray(routes)
    ? routes.flatMap((entry: unknown) => {
        const route = entry as Partial<HostRoute> | null;
        return typeof route?.hostname === "string" &&
          typeof route.upstream === "string"
          ? [{ hostname: route.hostname, upstream: route.upstream }]
          : [];
      })
    : [];
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
/** What of `requested` (Host config now, or the error reading it) Caddy does not serve; undefined when it serves exactly
 * that. */
export async function pendingSettings(
  root: string,
  requested: ProxySettings | Error,
): Promise<PendingSettings | undefined> {
  if (requested instanceof Error)
    return {
      fields: [],
      reason: `Host config cannot be read, so Caddy keeps the settings it last accepted: ${requested.message}`,
      ...("code" in requested && typeof requested.code === "string"
        ? { code: requested.code }
        : {}),
    };
  const accepted = await acceptedProxySettings(root);
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
