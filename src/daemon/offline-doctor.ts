import { inspectHost } from "../adapters/host-inspection";
import { discoverProject } from "../config";
import { ConfigError } from "../config/errors";
export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  reason?: string;
  hint?: string;
}
/** Read-only diagnostics continue even when the runtime authority is unavailable. */
export async function inspectOfflineHost(
  root: string,
  cwd: string,
): Promise<{ ok: false; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [
    {
      name: "rigd",
      ok: false,
      message: "The daemon is not reachable.",
      reason: "daemon-unreachable",
      hint: "Run rigd status, then rigd install if needed.",
    },
  ];
  checks.push(...(await inspectHost(root)));
  try {
    const { document } = await discoverProject(cwd);
    checks.push({
      name: "project-config",
      ok: true,
      message: `Project '${document.config.name}' configuration is valid.`,
    });
  } catch (error) {
    if (!(error instanceof ConfigError) || error.code !== "missing_config")
      checks.push({
        name: "project-config",
        ok: false,
        message:
          error instanceof ConfigError
            ? error.message
            : "Project discovery failed.",
        reason: "config-invalid",
        hint:
          error instanceof ConfigError
            ? error.hint
            : "Inspect the Project directory.",
      });
  }
  return { ok: false, checks };
}
