import { z } from "zod"

// ── Helpers ─────────────────────────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+$/
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const noBindAll = (fieldName: string) =>
  z.string().refine((s) => !s.includes("0.0.0.0"), {
    message: `${fieldName} must use 127.0.0.1, not 0.0.0.0. Rig enforces localhost-only binding.`,
  })

const ServiceNameSchema = z
  .string()
  .min(1)
  .regex(
    SERVICE_NAME_RE,
    "Service name must be lowercase alphanumeric with hyphens only."
  )
  .describe(
    "Unique service name within this environment. Safe for file paths and process labels."
  )

// ── Hooks ───────────────────────────────────────────────────────────────────

export const ServiceHooksSchema = z
  .object({
    preStart: z
      .string()
      .nullable()
      .optional()
      .describe("Command to run before this service starts."),
    postStart: z
      .string()
      .nullable()
      .optional()
      .describe("Command to run after this service is healthy."),
    preStop: z
      .string()
      .nullable()
      .optional()
      .describe("Command to run before sending SIGTERM to this service."),
    postStop: z
      .string()
      .nullable()
      .optional()
      .describe("Command to run after this service is confirmed stopped."),
  })
  .describe("Lifecycle hooks for this service.")

export const TopLevelHooksSchema = z
  .object({
    preStart: z
      .string()
      .nullable()
      .optional()
      .describe("Command to run before any service starts (e.g. install deps)."),
    postStart: z
      .string()
      .nullable()
      .optional()
      .describe("Command to run after all services are healthy."),
    preStop: z
      .string()
      .nullable()
      .optional()
      .describe("Command to run before stopping services."),
    postStop: z
      .string()
      .nullable()
      .optional()
      .describe("Command to run after all services are confirmed stopped."),
  })
  .describe("Top-level lifecycle hooks. Run before/after service-level hooks.")

// ── Service Schemas ─────────────────────────────────────────────────────────

export const ServerServiceSchema = z
  .object({
    name: ServiceNameSchema,
    type: z.literal("server").describe("server = long-running daemon."),
    command: noBindAll("command").describe(
      "Shell command to start this service. Must bind to 127.0.0.1."
    ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .describe("Port this service listens on."),
    healthCheck: noBindAll("healthCheck")
      .optional()
      .describe(
        "HTTP URL or command to check service health. URLs must use 127.0.0.1."
      ),
    readyTimeout: z
      .number()
      .int()
      .min(1)
      .default(30)
      .describe("Seconds to wait for health check to pass before failing. Default: 30."),
    dependsOn: z
      .array(ServiceNameSchema)
      .optional()
      .describe("Service names that must be healthy before this one starts."),
    hooks: ServiceHooksSchema.optional(),
    envFile: z
      .string()
      .optional()
      .describe(
        "Env file for this service. Overrides the environment-level envFile if set."
      ),
  })
  .describe("Long-running daemon service. Managed as a process with health checks.")

export const BinServiceSchema = z
  .object({
    name: ServiceNameSchema,
    type: z.literal("bin").describe("bin = CLI tool installed to ~/.rig/bin/."),
    entrypoint: z
      .string()
      .min(1)
      .describe(
        "Path to binary/script or a command string (e.g. 'bun cli/index.ts'). " +
          "See Bin Resolution Logic in DESIGN.md."
      ),
    build: z
      .string()
      .optional()
      .describe(
        "Build command to compile the binary (e.g. 'bun build --compile ...'). " +
          "If set, entrypoint must be a file path, not a command string."
      ),
    hooks: ServiceHooksSchema.optional(),
    envFile: z
      .string()
      .optional()
      .describe(
        "Env file for this service. Overrides the environment-level envFile if set."
      ),
  })
  .refine(
    (s) => {
      if (s.build && s.entrypoint.includes(" ")) return false
      return true
    },
    {
      message:
        "Cannot use 'build' when entrypoint is a command string (contains spaces). " +
        "Use hooks.preStart for pre-build steps instead.",
      path: ["build"],
    }
  )
  .describe("CLI tool service. Built and/or installed to ~/.rig/bin/.")

export const ServiceSchema = z
  .discriminatedUnion("type", [ServerServiceSchema, BinServiceSchema])
  .describe("A service definition. Either a server (daemon) or bin (CLI tool).")

// ── Proxy ───────────────────────────────────────────────────────────────────

export const ProxySchema = z
  .object({
    upstream: z
      .string()
      .min(1)
      .describe("Name of the service to route traffic to. Must match a service name in this environment."),
  })
  .describe("Reverse proxy config. Routes the domain to the named upstream service.")

// ── Environment ─────────────────────────────────────────────────────────────

export const EnvironmentSchema = z
  .object({
    envFile: z
      .string()
      .optional()
      .describe("Default env file for all services in this environment."),
    proxy: ProxySchema.optional().describe(
      "Reverse proxy config for this environment."
    ),
    services: z
      .array(ServiceSchema)
      .min(1)
      .describe("Services to run in this environment.")
      .superRefine((services, ctx) => {
        // Validate service names are unique
        const names = new Set<string>()
        for (const svc of services) {
          if (names.has(svc.name)) {
            ctx.addIssue({
              code: "custom",
              message: `Duplicate service name "${svc.name}". Service names must be unique within an environment.`,
              path: [services.indexOf(svc), "name"],
            })
          }
          names.add(svc.name)
        }

        // Validate dependsOn references exist
        for (const svc of services) {
          if (svc.type === "server" && svc.dependsOn) {
            for (const dep of svc.dependsOn) {
              if (!names.has(dep)) {
                ctx.addIssue({
                  code: "custom",
                  message: `Service "${svc.name}" depends on "${dep}", but no service with that name exists in this environment.`,
                  path: [services.indexOf(svc), "dependsOn"],
                })
              }
            }
          }
        }
      }),
  })
  .superRefine((env, ctx) => {
    // Validate proxy upstream references a service
    if (env.proxy) {
      const serviceNames = env.services.map((s) => s.name)
      if (!serviceNames.includes(env.proxy.upstream)) {
        ctx.addIssue({
          code: "custom",
          message: `Proxy upstream "${env.proxy.upstream}" does not match any service name. Available: ${serviceNames.join(", ")}.`,
          path: ["proxy", "upstream"],
        })
      }
    }
  })
  .describe("Environment configuration (dev or prod).")

// ── Daemon ──────────────────────────────────────────────────────────────────

export const DaemonSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe("Whether to create a launchd plist for this project."),
    keepAlive: z
      .boolean()
      .default(false)
      .describe("Whether launchd should restart the service if it exits."),
  })
  .describe("launchd daemon configuration.")

// ── Top-level Config ────────────────────────────────────────────────────────

export const RigConfigSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, "Project name must be lowercase alphanumeric with hyphens only.")
      .describe("Project identifier. Used in all CLI commands and paths."),
    description: z
      .string()
      .optional()
      .describe("Human-readable project description."),
    version: z
      .string()
      .regex(SEMVER_RE, "Version must be valid semver (e.g. 0.1.0).")
      .describe("Semver string. Starts at 0.0.0. Bump with: rig version <name> patch|minor|major."),
    domain: z
      .string()
      .optional()
      .describe("Base domain. Prod uses domain directly, dev uses dev.<domain>."),
    mainBranch: z
      .string()
      .optional()
      .describe(
        "Explicit main branch name. If not set, rig auto-detects via remote HEAD or convention (main/master)."
      ),
    hooks: TopLevelHooksSchema.optional(),
    environments: z
      .object({
        prod: EnvironmentSchema.optional().describe("Production environment configuration."),
        dev: EnvironmentSchema.optional().describe("Development environment configuration."),
      })
      .describe("Environment definitions. At least one of prod or dev must be defined.")
      .refine((envs) => envs.prod || envs.dev, {
        message: "At least one environment (prod or dev) must be defined.",
      }),
    daemon: DaemonSchema.optional(),
  })
  .describe("Root rig.json configuration file.")

// ── Inferred Types ──────────────────────────────────────────────────────────

export type RigConfig = z.infer<typeof RigConfigSchema>
export type ServerService = z.infer<typeof ServerServiceSchema>
export type BinService = z.infer<typeof BinServiceSchema>
export type Service = z.infer<typeof ServiceSchema>
export type Environment = z.infer<typeof EnvironmentSchema>
export type ServiceHooks = z.infer<typeof ServiceHooksSchema>
export type TopLevelHooks = z.infer<typeof TopLevelHooksSchema>
export type ProxyConfig = z.infer<typeof ProxySchema>
export type DaemonConfig = z.infer<typeof DaemonSchema>
