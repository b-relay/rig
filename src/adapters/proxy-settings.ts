import { ConfigError } from "../config/errors";
import { readHostConfig } from "../config/documents";
import type { ProxySettings } from "../config/proxy-schema";
import { RigError } from "../domain/errors";

/** The proxy section of Host config as it is now, read at every publication of Rig's Caddy. A document that no longer parses
 * or validates (an edit since rigd started) is PROXY_CONFIG naming the fields at fault, so `rig proxy reload` says plainly
 * what to fix; Caddy keeps serving the settings it last accepted. A Host config without a proxy section is PROXY_CONFIG too. */
export async function readProxySettings(root: string): Promise<ProxySettings> {
  const host = await readHostConfig(root).catch((error: unknown) => {
    if (!(error instanceof ConfigError)) throw error;
    const issues = Array.isArray(error.context.issues)
      ? (error.context.issues as { path?: unknown; message?: unknown }[])
      : [];
    throw new RigError(
      "PROXY_CONFIG",
      `Host config cannot be read: ${error.message}${
        issues.length
          ? ` (${issues
              .slice(0, 3)
              .map(
                (issue) =>
                  `${Array.isArray(issue.path) ? issue.path.join(".") : ""}: ${String(issue.message)}`,
              )
              .join("; ")})`
          : ""
      }`,
      "Fix config.yaml under the Rig root and run rig proxy reload. Caddy keeps serving the proxy settings it last accepted.",
      { issues },
    );
  });
  if (!host.proxy)
    throw new RigError(
      "PROXY_CONFIG",
      "Host config no longer has a proxy section, but this rigd publishes through Rig's Caddy.",
      "Run rigd install to switch how routes are published.",
    );
  return host.proxy;
}
