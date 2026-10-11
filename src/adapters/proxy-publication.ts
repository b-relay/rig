import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { within } from "../domain/paths";
import { realPath } from "../providers/real-path";
import type { HostConfig } from "../config/types";
import {
  countOwnedRoutes,
  inspectProxyPublication,
  ownedRouteBlocks,
} from "../domain/proxy-publication";
import { proxyPaths } from "../domain/managed-proxy";
import type { ProxyPublication } from "../domain/proxy-publication";
export {
  inspectProxyPublication,
  proxyCheck,
} from "../domain/proxy-publication";
export type { ProxyPublication } from "../domain/proxy-publication";
/** Caddyfiles the usual macOS and Linux Caddy installations load when no host Caddyfile is configured. */
export const wellKnownHostCaddyfiles = [
  "/usr/local/etc/Caddyfile",
  "/opt/homebrew/etc/Caddyfile",
  "/etc/caddy/Caddyfile",
] as const;
/** Whether the route file Rig writes lies inside `root`, compared by real path, since a write goes through a symlink to its
 * target: Rig's own Caddy's always does, an external router's unless `providers.caddy.caddyfile` (or a symlink) puts it
 * elsewhere, where another Rig root may write its blocks too. */
export async function routeFileInRoot(
  root: string,
  host: Pick<HostConfig, "providers" | "proxyMode">,
): Promise<boolean> {
  if (host.proxyMode === "managed") return true;
  return within(
    await realPath(root),
    await realPath(
      host.providers.caddy.caddyfile ?? join(root, "proxy", "Caddyfile"),
    ),
  );
}
/** Reads the proxy file and host Caddyfiles from disk; missing files count as absent rather than failing. */
export function inspectHostProxy(
  root: string,
  host: Pick<HostConfig, "providers" | "proxyMode">,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ProxyPublication> {
  if (host.proxyMode === "managed") {
    const proxyFile = proxyPaths(root).routes;
    return readFile(proxyFile, "utf8")
      .catch(() => "")
      .then((text) => ({
        proxyFile,
        routes: countOwnedRoutes(text),
        blocks: ownedRouteBlocks(text),
        state: "managed" as const,
      }));
  }
  const caddy = host.providers.caddy;
  return inspectProxyPublication({
    proxyFile: caddy.caddyfile ?? join(root, "proxy", "Caddyfile"),
    hostCaddyfiles: caddy.host_caddyfile
      ? [caddy.host_caddyfile]
      : wellKnownHostCaddyfiles,
    environment,
    read: (file) =>
      readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR")
          return undefined;
        throw error;
      }),
  });
}
