import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostConfig } from "../config/types";
import { inspectProxyPublication } from "../domain/proxy-publication";
import type { ProxyPublication } from "../domain/proxy-publication";
export { inspectProxyPublication, proxyCheck } from "../domain/proxy-publication";
export type { ProxyPublication } from "../domain/proxy-publication";
/** Caddyfiles the usual macOS and Linux Caddy installations load when no host Caddyfile is configured. */
export const wellKnownHostCaddyfiles = [
  "/usr/local/etc/Caddyfile",
  "/opt/homebrew/etc/Caddyfile",
  "/etc/caddy/Caddyfile",
] as const;
/** Reads the proxy file and host Caddyfiles from disk; missing files count as absent rather than failing. */
export function inspectHostProxy(
  root: string,
  host: Pick<HostConfig, "providers">,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ProxyPublication> {
  const caddy = host.providers.caddy;
  return inspectProxyPublication({
    proxyFile: caddy.caddyfile ?? join(root, "proxy", "Caddyfile"),
    hostCaddyfiles: caddy.hostCaddyfile
      ? [caddy.hostCaddyfile]
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
