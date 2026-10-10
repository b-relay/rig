import { readFile, readlink, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ProxySettings } from "../config/proxy-schema";
import type { DoctorCheck } from "../daemon/offline-doctor";
import { generationFiles, proxyPaths } from "../domain/managed-proxy";
import { createCaddyAdmin } from "../providers/caddy-admin";
import { installedBinary } from "../providers/caddy-binary";
import { createCaddyJob } from "../providers/caddy-job";
import type { DaemonMode } from "../daemon/installation";
import { inspectProxyToken } from "./proxy-token";

/** Doctor's view of Rig's own Caddy (ADR 0014): the token, the binary, the job and the custom files. It reads files and asks
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
  checks.push(...(await customChecks(paths)));
  return checks;
}
/** Whether the current generation exists and serves the custom files as they are on disk. */
async function customChecks(
  paths: ReturnType<typeof proxyPaths>,
): Promise<DoctorCheck[]> {
  const target = await readlink(paths.current).catch(() => undefined);
  if (!target)
    return [
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
  const pending: string[] = [];
  for (const [disk, served] of [
    [paths.custom, files.custom],
    [paths.customGlobal, files.customGlobal],
  ] as const) {
    const [onDisk, accepted] = await Promise.all([
      readFile(disk, "utf8").catch(() => ""),
      readFile(served, "utf8").catch(() => ""),
    ]);
    if (onDisk !== accepted) pending.push(disk);
  }
  return [
    pending.length
      ? {
          name: "proxy-custom",
          ok: false,
          message: `${pending.join(" and ")} changed since it was last applied; Caddy serves the accepted copy.`,
          reason: "proxy-custom-pending",
          hint: "Run rig proxy reload to apply it.",
        }
      : {
          name: "proxy-custom",
          ok: true,
          message: "The custom files are applied.",
        },
  ];
}
