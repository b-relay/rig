import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { readHostConfig } from "../config";
import type { ProxyMode, ProxySettings } from "../config/proxy-schema";
import { inspectProxyToken } from "../adapters/proxy-token";
import { RigError, boundedEvidence, lastOutputLine } from "../domain/errors";
import {
  proxyPaths,
  redactSecrets,
  type ProxyPaths,
} from "../domain/managed-proxy";
import {
  createCaddyAdmin,
  type CaddyAdminClient,
} from "../providers/caddy-admin";
import {
  checkCaddyBinary,
  installCaddyBinary,
  installedBinary,
  switchBinary,
} from "../providers/caddy-binary";
import {
  caddySystemPlist,
  createCaddyJob,
  type InstallableCaddyJob,
  type LaunchctlCommand,
} from "../providers/caddy-job";
import type { CommandRunner } from "../providers/contracts";
import { createManagedCaddy } from "../providers/managed-caddy";

/** How `rigd install` and `rigd uninstall` set up and take down Rig's Caddy (ADR 0014). Every method assumes no rigd is
 * running under this root, so nothing else publishes at the same time. */
export interface ProxyInstallation {
  /** How Host config says routes are published. */
  mode(): Promise<ProxyMode>;
  /** Whether Rig's Caddy is installed as Host config asks: the binary proxy.caddy names, the job defined as this Rig defines
   * it and answering, and a current generation. */
  inSync(): Promise<boolean>;
  /** Installs Rig's Caddy and has it serve the current routes and custom files; resolves to warnings. `publish` replaces
   * publishing here, for a system rigd that keeps running and publishes itself (proxy-apply); `defineJob: false` stops
   * before the job, for a system job that needs the owner's sudo first. */
  install(how?: {
    publish?: () => Promise<unknown>;
    defineJob?: boolean;
  }): Promise<string[]>;
  /** The plist of Rig's Caddy as a system job (`daemon.start: boot`). */
  systemJob(): { label: string; plist: string };
  /** Refuses, before anything stops, what install would refuse from Host config alone: a missing proxy section, both
   * sections written, the token, and a proxy.caddy that is not Caddy 2.10 or later with the DNS module. */
  preflight(): Promise<void>;
  /** Removes Rig's Caddy job that needs no root (the process or the LaunchAgent), if one is defined. Certificates,
   * generations, custom files and the token stay. */
  remove(): Promise<void>;
}
export interface ProxyInstallationOptions {
  readonly root: string;
  readonly userHome: string;
  readonly uid: number;
  /** How rigd was launched under this root; a launchd install becomes a system job when daemon.start is boot. */
  readonly mode: "process" | "launchd";
  /** The account a system job runs as. */
  readonly userName: string;
  /** Where system plists live; tests pass a temporary directory. */
  readonly daemons?: string;
  readonly run: CommandRunner;
  readonly launchctl?: LaunchctlCommand;
  /** How long Caddy may take to answer after a start; launchd's 10 s throttle is inside it. */
  readonly startDeadlineMs?: number;
}
export function createProxyInstallation(
  options: ProxyInstallationOptions,
): ProxyInstallation {
  const paths = proxyPaths(options.root);
  const admin = createCaddyAdmin(paths.socket);
  /** The Caddy job beside rigd: a process under RIG_ROOT, otherwise as daemon.start in Host config says now. */
  async function currentJob(): Promise<InstallableCaddyJob> {
    const host = await readHostConfig(options.root).catch(() => undefined);
    return createCaddyJob({
      root: options.root,
      paths,
      mode:
        options.mode === "process"
          ? "process"
          : host?.daemon.start === "boot"
            ? "system"
            : "launchd",
      userHome: options.userHome,
      uid: options.uid,
      userName: options.userName,
      admin,
      ...(options.launchctl ? { launchctl: options.launchctl } : {}),
      ...(options.startDeadlineMs
        ? { deadlineMs: options.startDeadlineMs }
        : {}),
      ...(options.daemons ? { daemons: options.daemons } : {}),
    });
  }
  async function settings(): Promise<ProxySettings> {
    const host = await readHostConfig(options.root);
    if (host.proxyMode !== "managed" || !host.proxy)
      throw new RigError(
        "PROXY_CONFIG",
        "Host config has no proxy section.",
        "Add a proxy section to config.yaml under the Rig root.",
      );
    if (host.externalIgnored)
      throw new RigError(
        "PROXY_CONFIG",
        "Host config has both a proxy section and providers.caddy.",
        "Delete providers.caddy from config.yaml under the Rig root: the proxy section replaces it.",
      );
    return host.proxy;
  }
  return {
    mode: async () => (await readHostConfig(options.root)).proxyMode,
    async inSync() {
      const wanted = await settings().catch(() => undefined);
      if (!wanted) return false;
      const job = await currentJob();
      const digest = await readFile(wanted.caddy)
        .then((content) => createHash("sha256").update(content).digest("hex"))
        .catch(() => undefined);
      return (
        digest !== undefined &&
        (await installedBinary(paths))?.endsWith(digest.slice(0, 16)) ===
          true &&
        (await stat(paths.entry).catch(() => undefined)) !== undefined &&
        (await job.matches()) &&
        (await job.state()) === "running" &&
        (await admin.reachable())
      );
    },
    async install(how = {}) {
      const wanted = await settings();
      await requireToken(options.root, wanted);
      const warnings: string[] = [];
      const job = await currentJob();
      const wasRunning = (await job.state()) === "running";
      const caddy = createManagedCaddy({
        root: options.root,
        settings,
        run: options.run,
        job,
        admin,
      });
      const binary = await installCaddyBinary({
        source: wanted.caddy,
        paths,
        dns: wanted.tls.dns,
        run: options.run,
        validate: async (file) => {
          if (!(await stat(paths.entry).catch(() => undefined))) return;
          await validateWith(file, paths, options.run, options.root);
        },
      });
      // Until the new binary serves, any failure puts the previous one back, so the link never names a binary the running
      // Caddy is not, and the next install sees the change again.
      const restoreBinary = async () => {
        if (binary.changed && binary.previous)
          await switchBinary(paths, binary.previous);
      };
      try {
        // The custom files on disk are applied; when Caddy rejects them, install still succeeds with the accepted ones.
        try {
          await (how.publish ? how.publish() : caddy.applyCustom());
        } catch (error) {
          if (!(
            error instanceof RigError && error.code === "PROXY_CUSTOM_INVALID"
          ))
            throw error;
          warnings.push(
            `${error.message} The previously accepted custom files are used; fix them and run rig proxy reload.`,
          );
          if (!how.publish) await caddy.republish();
        }
      } catch (error) {
        await restoreBinary();
        throw error;
      }
      if (how.defineJob === false) return warnings;
      try {
        const defined = await job.install();
        // A job that kept running still runs the old binary until it starts again.
        if (binary.changed && wasRunning && !defined.changed)
          await job.restart();
      } catch (error) {
        await restoreBinary();
        // Only a Caddy that did not come up blames the new binary; launchd refusing the job does not.
        if (
          !binary.changed ||
          !binary.previous ||
          !(error instanceof RigError && error.code === "PROXY_START")
        )
          throw error;
        await job.restart().catch(() => job.install().catch(() => {}));
        throw new RigError(
          "PROXY_BINARY_START",
          `The new Caddy (${binary.version}) did not start, so the previous one runs again.`,
          `Read ${paths.jobLog} for why it failed, fix proxy.caddy, then run rigd install again.`,
          {
            evidence: boundedEvidence(
              await lastLines(paths.jobLog, options.root),
            ),
          },
        );
      }
      return warnings;
    },
    async preflight() {
      const wanted = await settings();
      await requireToken(options.root, wanted);
      if (!(await stat(wanted.caddy).catch(() => undefined))?.isFile())
        throw new RigError(
          "PROXY_BINARY",
          `proxy.caddy names ${wanted.caddy}, which is not a file.`,
          "Set proxy.caddy in Host config to a Caddy executable built with the DNS module.",
          { source: wanted.caddy },
        );
      await checkCaddyBinary({
        file: wanted.caddy,
        source: wanted.caddy,
        dns: wanted.tls.dns,
        run: options.run,
      });
    },
    // The job rigd install can remove itself: the process, or the LaunchAgent, which stays behind when a switch to boot was
    // never completed. A system job needs root; rigd install and uninstall print its line.
    remove: () =>
      createCaddyJob({
        root: options.root,
        paths,
        mode: options.mode === "process" ? "process" : "launchd",
        userHome: options.userHome,
        uid: options.uid,
        userName: options.userName,
        admin,
        ...(options.launchctl ? { launchctl: options.launchctl } : {}),
      }).remove(),
    systemJob: () =>
      caddySystemPlist({
        root: options.root,
        paths,
        userHome: options.userHome,
        userName: options.userName,
      }),
  };
}
/** Refuses an install that would leave Caddy unable to provision: no token, or one that is malformed or readable by others. */
async function requireToken(
  root: string,
  settings: ProxySettings,
): Promise<void> {
  if (settings.tls.ca === "internal") return;
  const token = await inspectProxyToken(root);
  if (token.state === "ok") return;
  const path = proxyPaths(root).token;
  throw new RigError(
    "PROXY_TOKEN",
    {
      missing: `No DNS API token is stored at ${path}.`,
      unreadable: `The DNS API token at ${path} cannot be read.`,
      malformed: `The DNS API token at ${path} is malformed.`,
      exposed: `The DNS API token at ${path} is readable by other users.`,
      foreign: `The DNS API token at ${path} belongs to another user.`,
    }[token.state],
    "Pipe a Cloudflare API token with Zone:DNS:Edit and Zone:Zone:Read on your zone to rig proxy token, which stores it correctly.",
    { path, state: token.state },
  );
}
/** Validates the current generation with a candidate binary before the job switches to it. */
async function validateWith(
  binary: string,
  paths: ProxyPaths,
  run: CommandRunner,
  root: string,
): Promise<void> {
  const result = await run({
    command: [
      binary,
      "validate",
      "--config",
      paths.entry,
      "--adapter",
      "caddyfile",
    ],
  }).catch((error: unknown) => ({
    exitCode: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  if (result.exitCode === 0) return;
  const reason = lastOutputLine(
    redactSecrets(result.stderr, await secrets(root)),
  );
  throw new RigError(
    "PROXY_BINARY",
    `The new Caddy rejects the current configuration${reason ? `: ${reason}` : "."}`,
    "Keep the Caddy that runs now, or fix the configuration first.",
    { evidence: boundedEvidence(reason ?? "") },
  );
}
async function secrets(root: string): Promise<string[]> {
  const token = await readFile(proxyPaths(root).token, "utf8").catch(
    () => undefined,
  );
  return token ? [token.trim()] : [];
}
/** The last lines of a log, with the token redacted, as evidence of why Caddy did not start. */
async function lastLines(path: string, root: string): Promise<string> {
  const text = await readFile(path, "utf8").catch(() => "");
  return redactSecrets(
    text.split("\n").filter(Boolean).slice(-5).join("\n"),
    await secrets(root),
  );
}
export type { CaddyAdminClient };
