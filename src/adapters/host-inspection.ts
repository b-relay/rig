import { access, constants, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { readHostConfig } from "../config";
import { ConfigError } from "../config/errors";
import type { DoctorCheck } from "../daemon/offline-doctor";
import { inspectHostProxy, proxyCheck } from "./proxy-publication";
import { readInstallationRecord } from "../daemon/installation";
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
    checks.push(
      await inspectHostProxy(root, host, process.env).then(
        proxyCheck,
        (error) => ({
          name: "caddy-proxy",
          ok: false,
          message: `Rig's route file or the host Caddyfile could not be read: ${String((error as Error).message ?? error)}`,
          reason: "proxy-unreadable",
          hint: "Make the Caddyfiles readable by the rigd user, or set providers.caddy.host_caddyfile.",
        }),
      ),
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
/** An installed daemon whose recorded program is gone (for example after a package upgrade) can never start; naming it beats
 * "unreachable". Likewise a recorded bun that is gone makes every Tool whose bin is a source file fail to install. */
async function inspectDaemonExecutable(root: string): Promise<DoctorCheck[]> {
  let installation;
  try {
    installation = await readInstallationRecord(root);
  } catch {
    return [];
  }
  const checks: DoctorCheck[] = [];
  const executable = installation?.command?.[0];
  if (executable && !(await isExecutable(executable)))
    checks.push({
      name: "daemon-executable",
      ok: false,
      message: `The installed daemon program ${executable} is missing or not executable.`,
      reason: "missing-executable",
      hint: "Run rigd install again to record the current executable.",
    });
  const bun = installation?.bun;
  if (bun && !(await isExecutable(bun)))
    checks.push({
      name: "tool-bun",
      ok: false,
      message: `The bun recorded for Tools whose bin is a source file, ${bun}, is missing or not an executable file.`,
      reason: "missing-executable",
      hint: "Run rigd install again from a shell whose PATH finds bun.",
    });
  return checks;
}
/** A regular file the operator may execute; a directory is searchable, so X_OK alone would pass it. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
