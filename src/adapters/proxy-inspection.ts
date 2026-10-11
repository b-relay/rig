import { readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import type { ProxySettings } from "../config/proxy-schema";
import type { DoctorCheck } from "../daemon/offline-doctor";
import { proxyPaths } from "../domain/managed-proxy";
import {
  currentGeneration,
  pendingSettings,
  type PublishedGeneration,
} from "./proxy-generation";
import { canonicalRouteFile } from "../providers/route-file";
import {
  createCaddyAdmin,
  type CaddyAdminClient,
} from "../providers/caddy-admin";
import type { CaddyJob } from "../providers/managed-caddy";
import { installedBinary } from "../providers/caddy-binary";
import { createCaddyJob } from "../providers/caddy-job";
import type { DaemonMode } from "../daemon/installation";
import { inspectProxyToken } from "./proxy-token";

/** Doctor's view of Rig's own Caddy (ADR 0014): the token, the binary, the job, the owner's routes and any retired custom
 * Caddy file left on disk. It reads files and asks
 * launchd and the admin socket; it changes nothing and contacts nothing beyond this machine. */
export async function inspectManagedProxy(
  root: string,
  settings: ProxySettings,
  mode: DaemonMode,
  /** The admin socket and job to ask; Rig's own for `root` unless a test passes others. */
  observe?: {
    readonly admin: CaddyAdminClient;
    readonly job: Pick<CaddyJob, "state"> & { readonly description: string };
  },
): Promise<DoctorCheck[]> {
  const paths = proxyPaths(root);
  const checks: DoctorCheck[] = [];
  if (settings.tls.ca !== "internal") {
    const token = await inspectProxyToken(root);
    checks.push(
      token.state === "ok"
        ? {
            name: "proxy-token",
            ok: true,
            message: "The DNS API token is stored with mode 600.",
          }
        : {
            name: "proxy-token",
            ok: false,
            message: {
              missing: `No DNS API token is stored at ${paths.token}; Caddy cannot get certificates or start.`,
              unreadable: `The DNS API token at ${paths.token} cannot be read.`,
              malformed: `The DNS API token at ${paths.token} is malformed.`,
              exposed: `The DNS API token at ${paths.token} is readable by other users.`,
              foreign: `The DNS API token at ${paths.token} belongs to another user.`,
            }[token.state],
            reason: `token-${token.state}`,
            hint: "Pipe the Cloudflare API token to rig proxy token, which stores it correctly.",
          },
    );
  }
  const binary = await installedBinary(paths);
  checks.push(
    binary && (await stat(binary).catch(() => undefined))
      ? {
          name: "proxy-binary",
          ok: true,
          message: `Rig's Caddy runs ${binary}.`,
        }
      : {
          name: "proxy-binary",
          ok: false,
          message: `Rig's copy of Caddy is missing from ${paths.bin}.`,
          reason: "missing-executable",
          hint: "Run rigd install, which copies and checks the Caddy proxy.caddy names.",
        },
  );
  const admin = observe?.admin ?? createCaddyAdmin(paths.socket);
  const job =
    observe?.job ??
    createCaddyJob({
      root,
      paths,
      mode,
      userHome: homedir(),
      uid: process.getuid?.() ?? 501,
      userName: userInfo().username,
      admin,
    });
  const [state, reachable] = await Promise.all([
    job.state(),
    admin.reachable(),
  ]);
  checks.push(
    reachable
      ? {
          name: "proxy-process",
          ok: true,
          message: "Rig's Caddy is running and answers on its admin socket.",
        }
      : state === "stopped"
        ? {
            name: "proxy-process",
            ok: false,
            message: `Rig's Caddy is not running (${job.description}), so no route is served.`,
            reason: "proxy-stopped",
            hint: `Run rigd install; if Caddy stops again, read the end of ${paths.jobLog}.`,
          }
        : {
            name: "proxy-process",
            ok: false,
            message:
              state === "running"
                ? "Rig's Caddy is running but its admin socket does not answer, so route changes fail until it does."
                : "Rig's Caddy could not be observed: launchd did not say whether it runs.",
            reason: "proxy-unreachable",
            hint: `Run rigd install to restart it, and read the end of ${paths.log} if it stays unreachable.`,
          },
  );
  // One generation for the whole inspection, resolved once: its settings, routes and adapted JSON all come from it.
  const generation = await currentGeneration(root);
  checks.push(...(await generationChecks(root, paths, settings, generation)));
  // What Caddy runs, not what the files say: after a crash between switching and activating they differ.
  if (reachable) {
    const loaded = await admin.config();
    const expected = generation?.adapted;
    if (expected !== undefined)
      checks.push(
        Bun.deepEquals(loaded, expected)
          ? {
              name: "proxy-serving",
              ok: true,
              message:
                "Rig's Caddy serves the current configuration generation.",
            }
          : {
              name: "proxy-serving",
              ok: false,
              message:
                "Rig's Caddy serves a configuration other than the current generation, so route changes wait until it does.",
              reason: "proxy-stale",
              hint: "Run rig proxy reload, which makes Caddy serve the current generation.",
            },
      );
  }
  return checks;
}
/** Whether the current generation exists and serves the proxy section of Host config as it says now (refused settings say
 * why), and which retired custom Caddy files are left on disk, ignored. */
async function generationChecks(
  root: string,
  paths: ReturnType<typeof proxyPaths>,
  settings: ProxySettings,
  generation: PublishedGeneration | undefined,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const file of paths.retiredCustomFiles)
    if (await stat(file).catch(() => undefined))
      checks.push({
        name: "proxy-custom-file",
        ok: false,
        message: `Rig no longer reads ${file}, so nothing in it is served.`,
        reason: "proxy-custom-retired",
        hint: "Put each of its hostnames under proxy.routes in config.yaml, as hostname: port, run rig proxy reload, then delete the file.",
      });
  // Rig's Caddy publishes only what Rig renders from the route file's blocks; anything else in it is named and ignored.
  const routeFile = await readFile(paths.routes, "utf8").catch(() => "");
  if (canonicalRouteFile(routeFile).dropped)
    checks.push({
      name: "proxy-route-file",
      ok: false,
      message: `${paths.routes} holds text Rig did not write (an external router's extra_config, or an edit). Rig's Caddy never publishes it, and the next route change or reload rewrites the file without it.`,
      reason: "proxy-route-file-foreign",
      hint: "Run rig proxy reload to rewrite the route file now.",
    });
  if (!generation)
    return [
      ...checks,
      {
        name: "proxy-config",
        ok: false,
        message: "Rig's Caddy has no current configuration generation.",
        reason: "proxy-unconfigured",
        hint: "Run rigd install.",
      },
    ];
  const pending = await pendingSettings(root, settings, generation.proxy);
  checks.push(
    pending
      ? {
          name: "proxy-settings",
          ok: false,
          message: `The proxy section of config.yaml${pending.fields.length ? ` (${pending.fields.join(", ")})` : ""} is not what Rig's Caddy serves: ${pending.reason}`,
          reason: pending.code
            ? "proxy-settings-refused"
            : "proxy-settings-pending",
          hint: pending.code
            ? "Fix the proxy section of config.yaml and run rig proxy reload. Caddy keeps serving the settings it last accepted."
            : "Run rig proxy reload to apply it.",
        }
      : {
          name: "proxy-settings",
          ok: true,
          message: "Rig's Caddy serves the proxy section of config.yaml.",
        },
  );
  return checks;
}
