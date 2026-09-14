import { access, constants, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { readHostConfig } from "../config";
import { ConfigError } from "../config/errors";
import type { DoctorCheck } from "../daemon/offline-doctor";
import { inspectHostProxy, proxyCheck } from "./proxy-publication";
/** Observe local prerequisites without running repairs, writing probes, or contacting remotes. */
export async function inspectHost(root: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    const host = await readHostConfig(root);
    checks.push({
      name: "host-config",
      ok: true,
      message: "Host configuration is valid.",
    });
    if (
      host.providers.caddy.reload.mode === "command" &&
      !host.providers.caddy.reload.command
    )
      checks.push({
        name: "caddy-reload",
        ok: false,
        message: "Caddy command reload has no command configured.",
        reason: "missing-reload-command",
        hint: "Set providers.caddy.reload.command or choose manual reload.",
      });
    checks.push(
      await inspectHostProxy(root, host, process.env).then(proxyCheck, (error) => ({
        name: "caddy-proxy",
        ok: false,
        message: `Rig's route file or the host Caddyfile could not be read: ${String((error as Error).message ?? error)}`,
        reason: "proxy-unreadable",
        hint: "Make the Caddyfiles readable by the rigd user, or set providers.caddy.hostCaddyfile.",
      })),
    );
  } catch (error) {
    checks.push({
      name: "host-config",
      ok: false,
      message:
        error instanceof ConfigError
          ? error.message
          : "Host configuration could not be read.",
      reason: "config-invalid",
      hint:
        error instanceof ConfigError
          ? error.hint
          : "Inspect Host configuration.",
    });
  }
  checks.push(...(await inspectDaemonExecutable(root)));
  for (const name of ["bun", "git", "caddy"]) {
    const ok = Bun.which(name) !== null;
    checks.push(
      ok
        ? {
            name: `provider/${name}`,
            ok: true,
            message: `${name} is available.`,
          }
        : {
            name: `provider/${name}`,
            ok: false,
            message: `${name} is unavailable.`,
            reason: "missing-capability",
            hint: `Install ${name} and include it in PATH.`,
          },
    );
  }
  try {
    await access(root, constants.R_OK | constants.W_OK);
    checks.push({
      name: "state-path",
      ok: true,
      message: "Rig state directory is accessible.",
    });
  } catch {
    try {
      await access(dirname(root), constants.W_OK);
      checks.push({
        name: "state-path",
        ok: true,
        message: "Rig state directory can be created.",
      });
    } catch {
      checks.push({
        name: "state-path",
        ok: false,
        message: "Rig state directory is inaccessible.",
        reason: "permissions",
        hint: "Check directory permissions.",
      });
    }
  }
  return checks;
}
/** An installed daemon whose recorded program is gone (for example after a package upgrade) can never start; naming it beats "unreachable". */
async function inspectDaemonExecutable(root: string): Promise<DoctorCheck[]> {
  let executable: string | undefined;
  try {
    const installation = JSON.parse(
      await readFile(join(root, "daemon", "install.json"), "utf8"),
    ) as { command?: unknown };
    executable = Array.isArray(installation.command)
      ? String(installation.command[0] ?? "")
      : undefined;
  } catch {
    return [];
  }
  if (!executable) return [];
  try {
    await access(executable, constants.X_OK);
    return [];
  } catch {
    return [
      {
        name: "daemon-executable",
        ok: false,
        message: `The installed daemon program ${executable} is missing or not executable.`,
        reason: "missing-executable",
        hint: "Run rigd install again to record the current executable.",
      },
    ];
  }
}
