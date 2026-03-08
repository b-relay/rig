import { z } from "zod"

// ── Shared ──────────────────────────────────────────────────────────────────

const EnvFlag = z
  .enum(["dev", "prod"])
  .describe("Target environment. Always required — rig never assumes a default.")

const ProjectName = z
  .string()
  .min(1)
  .describe("Project name as registered in the rig registry.")

// ── rig init ────────────────────────────────────────────────────────────────

export const InitArgsSchema = z
  .object({
    name: ProjectName,
    path: z.string().min(1).describe("Absolute path to the project repository."),
  })
  .describe("Arguments for 'rig init <name> --path <project-path>'.")

// ── rig deploy ──────────────────────────────────────────────────────────────

export const DeployArgsSchema = z
  .object({
    name: ProjectName,
    env: EnvFlag,
  })
  .describe("Arguments for 'rig deploy <name> --dev|--prod'.")

// ── rig start ───────────────────────────────────────────────────────────────

export const StartArgsSchema = z
  .object({
    name: ProjectName,
    env: EnvFlag,
    foreground: z
      .boolean()
      .default(false)
      .describe("Stay in foreground (used by launchd). Monitors services and exits if any die."),
  })
  .describe("Arguments for 'rig start <name> --dev|--prod [--foreground]'.")

// ── rig stop ────────────────────────────────────────────────────────────────

export const StopArgsSchema = z
  .object({
    name: ProjectName,
    env: EnvFlag,
  })
  .describe("Arguments for 'rig stop <name> --dev|--prod'.")

// ── rig restart ─────────────────────────────────────────────────────────────

export const RestartArgsSchema = z
  .object({
    name: ProjectName,
    env: EnvFlag,
  })
  .describe("Arguments for 'rig restart <name> --dev|--prod'.")

// ── rig status ──────────────────────────────────────────────────────────────

export const StatusArgsSchema = z
  .object({
    name: ProjectName.optional().describe("Project name. If omitted, shows status of all projects."),
    env: EnvFlag.optional().describe("Filter by environment. If omitted, shows both."),
  })
  .describe("Arguments for 'rig status [<name>] [--dev|--prod]'.")

// ── rig logs ────────────────────────────────────────────────────────────────

export const LogsArgsSchema = z
  .object({
    name: ProjectName,
    env: EnvFlag,
    follow: z
      .boolean()
      .default(false)
      .describe("Stream logs in real-time (like tail -f)."),
    lines: z
      .number()
      .int()
      .min(1)
      .default(50)
      .describe("Number of log lines to show. Default: 50."),
    service: z
      .string()
      .optional()
      .describe("Filter logs to a specific service. If omitted, shows all."),
  })
  .describe("Arguments for 'rig logs <name> --dev|--prod [--follow] [--lines N] [--service S]'.")

// ── rig version ─────────────────────────────────────────────────────────────

export const VersionArgsSchema = z
  .object({
    name: ProjectName,
    action: z
      .enum(["show", "patch", "minor", "major", "undo", "list"])
      .default("show")
      .describe(
        "Version action. 'show' = current version, 'patch|minor|major' = bump, " +
          "'undo' = revert last bump (if not deployed), 'list' = version history."
      ),
  })
  .describe("Arguments for 'rig version <name> [patch|minor|major|undo|list]'.")

// ── rig config ──────────────────────────────────────────────────────────────

export const ConfigArgsSchema = z
  .object({
    name: ProjectName.describe(
      "Project name to inspect. Parsed from [name] positional or auto-detected from cwd rig.json.",
    ),
  })
  .describe("Arguments for 'rig config [name]'.")

export const ConfigSetArgsSchema = z
  .object({
    name: ProjectName.describe(
      "Project name whose rig.json should be updated. Parsed from [name] positional or auto-detected from cwd.",
    ),
    key: z
      .string()
      .min(1)
      .describe("Dot-notation config key path to update (for example 'version' or 'daemon.enabled')."),
    value: z
      .string()
      .describe("Raw value from CLI. Parsed with JSON.parse fallback to plain string before schema validation."),
  })
  .describe("Arguments for 'rig config set [name] <key> <value>'.")

// ── rig list ────────────────────────────────────────────────────────────────

export const ListArgsSchema = z
  .object({})
  .describe("Arguments for 'rig list'. No arguments — lists all managed projects.")

// ── Inferred Types ──────────────────────────────────────────────────────────

export type InitArgs = z.infer<typeof InitArgsSchema>
export type DeployArgs = z.infer<typeof DeployArgsSchema>
export type StartArgs = z.infer<typeof StartArgsSchema>
export type StopArgs = z.infer<typeof StopArgsSchema>
export type RestartArgs = z.infer<typeof RestartArgsSchema>
export type StatusArgs = z.infer<typeof StatusArgsSchema>
export type LogsArgs = z.infer<typeof LogsArgsSchema>
export type VersionArgs = z.infer<typeof VersionArgsSchema>
export type ConfigArgs = z.infer<typeof ConfigArgsSchema>
export type ConfigSetArgs = z.infer<typeof ConfigSetArgsSchema>
export type ListArgs = z.infer<typeof ListArgsSchema>
