import { ConfigError } from "../config/errors";
import type { ConfigDocument, ProjectConfig } from "../config/types";
export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  reason?: string;
  hint?: string;
}
/** The observations offline doctor reports; the owner binds them to the host and the filesystem. */
export interface OfflineHostReads {
  inspectHost(root: string): Promise<DoctorCheck[]>;
  discoverProject(
    cwd: string,
  ): Promise<{ repoPath: string; document: ConfigDocument<ProjectConfig> }>;
}
/** Read-only diagnostics continue even when the runtime authority is unavailable. */
export async function inspectOfflineHost(
  root: string,
  cwd: string,
  reads: OfflineHostReads,
): Promise<{ ok: false; checks: DoctorCheck[]; note: string }> {
  const checks: DoctorCheck[] = [
    {
      name: "rigd",
      ok: false,
      message: "The daemon is not reachable.",
      reason: "daemon-unreachable",
      hint: "Run rigd status, then rigd install if needed.",
    },
  ];
  checks.push(...(await reads.inspectHost(root)));
  try {
    const { document } = await reads.discoverProject(cwd);
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
  return {
    ok: false,
    checks,
    note: "Project checks were skipped: rigd is not reachable.",
  };
}
