import { z } from "zod"

// ── Shared ──────────────────────────────────────────────────────────────────

const EnvironmentName = z
  .enum(["dev", "prod"])
  .describe("Target environment selected positionally.")

const ProjectName = z
  .string()
  .min(1)
  .describe("Project name as registered in the rig registry.")

const VersionSelector = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/)
  .describe("Specific production version to target, in MAJOR.MINOR.PATCH form.")

const BumpSelector = z
  .enum(["patch", "minor", "major"])
  .describe("Semantic version bump level.")

const EditSelector = z
  .union([VersionSelector, BumpSelector])
  .describe("Replacement semantic version or bump level for editing an existing release.")

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
    env: EnvironmentName,
    version: VersionSelector.optional(),
    bump: BumpSelector.optional(),
    revert: VersionSelector.optional(),
  })
  .describe("Arguments for 'rig deploy [name] <dev|prod> [--version <semver>] [--bump <patch|minor|major>] [--revert <semver>]'.")
  .superRefine((value, ctx) => {
    if (value.version && value.env !== "prod") {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "--version is only supported with --prod.",
      })
    }
    if (value.bump && value.env !== "prod") {
      ctx.addIssue({
        code: "custom",
        path: ["bump"],
        message: "--bump is only supported with prod deploys.",
      })
    }
    if (value.revert && value.env !== "prod") {
      ctx.addIssue({
        code: "custom",
        path: ["revert"],
        message: "--revert is only supported with prod deploys.",
      })
    }
    if (value.version && value.bump) {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "--version cannot be combined with --bump.",
      })
    }
    if (value.version && value.revert) {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "--version cannot be combined with --revert.",
      })
    }
    if (value.bump && value.revert) {
      ctx.addIssue({
        code: "custom",
        path: ["bump"],
        message: "--bump cannot be combined with --revert.",
      })
    }
  })

// ── rig start ───────────────────────────────────────────────────────────────

export const StartArgsSchema = z
  .object({
    name: ProjectName,
    env: EnvironmentName,
    version: VersionSelector.optional(),
    foreground: z
      .boolean()
      .default(false)
      .describe("Stay in foreground (used by launchd). Monitors services and exits if any die."),
  })
  .describe("Arguments for 'rig start [name] <dev|prod> [--version <semver>] [--foreground]'.")
  .superRefine((value, ctx) => {
    if (value.version && value.env !== "prod") {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "--version is only supported with --prod.",
      })
    }
  })

// ── rig stop ────────────────────────────────────────────────────────────────

export const StopArgsSchema = z
  .object({
    name: ProjectName,
    env: EnvironmentName,
    version: VersionSelector.optional(),
  })
  .describe("Arguments for 'rig stop [name] <dev|prod> [--version <semver>]'.")
  .superRefine((value, ctx) => {
    if (value.version && value.env !== "prod") {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "--version is only supported with --prod.",
      })
    }
  })

// ── rig restart ─────────────────────────────────────────────────────────────

export const RestartArgsSchema = z
  .object({
    name: ProjectName,
    env: EnvironmentName,
  })
  .describe("Arguments for 'rig restart [name] <dev|prod>'.")

// ── rig status ──────────────────────────────────────────────────────────────

export const StatusArgsSchema = z
  .object({
    name: ProjectName.optional().describe("Project name. If omitted, shows status of all projects."),
    env: EnvironmentName.optional().describe("Filter by environment. If omitted, shows both."),
    version: VersionSelector.optional(),
  })
  .describe("Arguments for 'rig status [<name>] [<dev|prod>] [--version <semver>]'.")
  .superRefine((value, ctx) => {
    if (value.version && value.env !== "prod") {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "--version is only supported with --prod.",
      })
    }
    if (value.version && !value.name) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "A project name is required when using --version.",
      })
    }
  })

// ── rig logs ────────────────────────────────────────────────────────────────

export const LogsArgsSchema = z
  .object({
    name: ProjectName,
    env: EnvironmentName,
    version: VersionSelector.optional(),
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
  .describe("Arguments for 'rig logs [name] <dev|prod> [--version <semver>] [--follow] [--lines N] [--service S]'.")
  .superRefine((value, ctx) => {
    if (value.version && value.env !== "prod") {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "--version is only supported with --prod.",
      })
    }
  })

// ── rig version ─────────────────────────────────────────────────────────────

export const VersionArgsSchema = z
  .object({
    name: ProjectName,
    targetVersion: VersionSelector.optional(),
    edit: EditSelector.optional(),
  })
  .describe("Arguments for 'rig version [name] [<semver>] [--edit <semver|patch|minor|major>]'.")
  .superRefine((value, ctx) => {
    if (value.edit && !value.targetVersion) {
      ctx.addIssue({
        code: "custom",
        path: ["edit"],
        message: "--edit requires a target version.",
      })
    }
  })

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
