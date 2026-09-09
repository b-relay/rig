import { access, constants } from "node:fs/promises";
import { dirname } from "node:path";
import { readHostConfig } from "../config";
import { ConfigError } from "../config/errors";
import type { DoctorCheck } from "../daemon/offline-doctor";
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
  for (const name of ["bun", "git"]) {
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
