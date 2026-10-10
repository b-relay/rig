import { readFile, readlink, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ProxySettings } from "../config/proxy-schema";
import type { DoctorCheck } from "../daemon/offline-doctor";
import {
  generationFiles,
  hostRoutes,
  proxyPaths,
} from "../domain/managed-proxy";
import { createCaddyAdmin } from "../providers/caddy-admin";
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
  const admin = createCaddyAdmin(paths.socket);
  const job = createCaddyJob({
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
  checks.push(...(await generationChecks(paths, settings)));
  // What Caddy runs, not what the files say: after a crash between switching and activating they differ.
  if (reachable) {
    const [loaded, expected] = await Promise.all([
      admin.config(),
      readFile(generationFiles(paths.current).adapted, "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => undefined),
    ]);
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
/** Whether the current generation exists and serves `proxy.routes` as Host config says now, and which retired custom Caddy
 * files are left on disk, ignored. */
async function generationChecks(
  paths: ReturnType<typeof proxyPaths>,
  settings: ProxySettings,
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
  const target = await readlink(paths.current).catch(() => undefined);
  if (!target)
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
  const files = generationFiles(
    target.startsWith("/") ? target : join(dirname(paths.current), target),
  );
  const served = await readFile(files.metadata, "utf8")
    .then(
      (text) =>
        (JSON.parse(text) as { customRoutes?: unknown }).customRoutes ?? [],
    )
    .catch(() => []);
  const wanted = hostRoutes(settings);
  if (wanted.length || (Array.isArray(served) && served.length))
    checks.push(
      Bun.deepEquals(served, wanted)
        ? {
            name: "proxy-routes",
            ok: true,
            message: `Your ${wanted.length === 1 ? "route" : `${wanted.length} routes`} in proxy.routes ${wanted.length === 1 ? "is" : "are"} served.`,
          }
        : {
            name: "proxy-routes",
            ok: false,
            message:
              "proxy.routes in config.yaml changed since Rig's Caddy last applied it.",
            reason: "proxy-routes-pending",
            hint: "Run rig proxy reload to apply it.",
          },
    );
  return checks;
}
