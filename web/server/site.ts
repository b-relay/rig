import { homedir } from "node:os";
import { resolveRigRoot } from "../../src/cli/entry-environment";
import { RigError } from "../../src/domain/errors";
import { accessKey } from "./access-key";
import {
  accessPolicy,
  parseTrustedClients,
  type AccessPolicy,
  type TrustedClient,
} from "./guard";

/** How this copy of the site was started: the Service's environment, read once. */
export interface SiteSettings {
  /** The loopback port the site serves on. */
  port: number;
  /** The Rig root whose rigd the site drives: the sandbox's when this copy is a Preview, else the Host's. */
  root: string;
  /** Set when this copy is a Preview: a throwaway rigd runs here, seeded with demo Projects. */
  sandboxRoot?: string;
  /** The file holding the access key clients beyond this Mac sign in with. */
  keyFile?: string;
  /** The name Caddy publishes this copy under. */
  publicHost?: string;
  /** The one published host whose dashboard controls the Host's rigd. */
  dashboardHost?: string;
  trustedClients: TrustedClient[];
  /** The repository the site runs from; the sandbox's rig and rigd run from its sources. */
  repository: string;
}
/** Pure: the settings named by a Service environment. A missing port or a malformed trusted
 * client stops the server rather than serving on a guess. */
export function siteSettings(
  env: Record<string, string | undefined>,
  home: string,
  cwd: string,
): SiteSettings {
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0)
    throw new RigError(
      "WEB_PORT_MISSING",
      "PORT does not name a localhost port to serve on.",
      "Run it as a Rig Service, or set PORT, for example PORT=4173.",
      { port: env.PORT },
    );
  const sandboxRoot = env.RIG_WEB_SANDBOX_ROOT;
  return {
    port,
    root: sandboxRoot ?? resolveRigRoot(env.RIG_ROOT, home),
    ...(sandboxRoot ? { sandboxRoot } : {}),
    ...(env.RIG_WEB_KEY_FILE ? { keyFile: env.RIG_WEB_KEY_FILE } : {}),
    ...(env.RIG_WEB_HOST ? { publicHost: env.RIG_WEB_HOST } : {}),
    ...(env.RIG_WEB_DASHBOARD_HOST
      ? { dashboardHost: env.RIG_WEB_DASHBOARD_HOST }
      : {}),
    trustedClients: parseTrustedClients(env.RIG_WEB_TRUSTED_CLIENTS ?? ""),
    repository: cwd,
  };
}
let settings: SiteSettings | undefined;
/** The running site's settings, read from the process environment on first use. */
export function site(): SiteSettings {
  settings ??= siteSettings(process.env, homedir(), process.cwd());
  return settings;
}
let policy: Promise<AccessPolicy> | undefined;
/** The running site's access policy. The first call creates the key file when there is none. */
export function sitePolicy(): Promise<AccessPolicy> {
  policy ??= (async () => {
    const current = site();
    const key = current.keyFile ? await accessKey(current.keyFile) : undefined;
    return accessPolicy({
      ...(key ? { accessKey: key } : {}),
      port: current.port,
      ...(current.publicHost ? { publicHost: current.publicHost } : {}),
      ...(current.dashboardHost
        ? { dashboardHost: current.dashboardHost }
        : {}),
      sandboxed: current.sandboxRoot !== undefined,
      trustedClients: current.trustedClients,
    });
  })();
  return policy;
}
