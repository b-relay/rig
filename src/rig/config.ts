import { Effect, Schema } from "effect"

import {
  resolveRigComponentPlugin,
  type ResolvedRigPreparedComponent,
  type RigComponentPluginId,
} from "./component-plugins.js"
import { RigConfigValidationError } from "./errors.js"

export interface ServiceHooks {
  readonly preStart?: string
  readonly postStart?: string
  readonly preStop?: string
  readonly postStop?: string
}

export interface TopLevelHooks extends ServiceHooks {}

export interface DaemonConfig {
  readonly enabled: boolean
  readonly keepAlive?: boolean
}

export type RuntimeService =
  | {
    readonly name: string
    readonly type: "server"
    readonly command: string
    readonly port: number
    readonly healthCheck?: string
    readonly readyTimeout?: number
    readonly dependsOn?: readonly string[]
    readonly hooks?: ServiceHooks
    readonly envFile?: string
  }
  | {
    readonly name: string
    readonly type: "bin"
    readonly entrypoint: string
    readonly build?: string
    readonly hooks?: ServiceHooks
    readonly envFile?: string
  }

export interface RuntimeRuntimeEnvironment {
  readonly deployBranch?: string
  readonly envFile?: string
  readonly proxy?: {
    readonly upstream: string
  }
  readonly services: readonly RuntimeService[]
}

export interface MigrationRuntimeConfig {
  readonly name: string
  readonly description?: string
  readonly version: string
  readonly domain?: string
  readonly hooks?: TopLevelHooks
  readonly environments: Readonly<Record<string, RuntimeRuntimeEnvironment>>
  readonly daemon?: DaemonConfig
}

const COMPONENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

const fieldDoc = <S extends Schema.Top>(schema: S, description: string): S["Rebuild"] =>
  schema.pipe(Schema.annotateKey({ description }))

const schemaDoc = <S extends Schema.Top>(schema: S, description: string): S["Rebuild"] =>
  schema.pipe(Schema.annotate({ description }))

const NonEmptyString = (description: string) =>
  fieldDoc(
    Schema.String.check(Schema.isMinLength(1, { message: "Must not be empty." })),
    description,
  )

const ProjectName = schemaDoc(
  Schema.String.check(
    Schema.isPattern(PROJECT_NAME_RE, {
      message: "Use letters, numbers, underscores, or hyphens, and start with a letter or number.",
    }),
  ),
  "Stable registered project name used for rig project identity.",
)

const ComponentName = schemaDoc(
  Schema.String.check(
    Schema.isPattern(COMPONENT_NAME_RE, {
      message: "Use lowercase letters, numbers, or hyphens, and start with a letter or number.",
    }),
  ),
  "Stable component key used for process labels, logs, dependency references, and generated service names.",
)

const RouteString = (description: string) =>
  fieldDoc(
    Schema.String.check(
      Schema.isMinLength(1, { message: "Must not be empty." }),
      Schema.isPattern(/^[^\s;"`]+$/, {
        message: "Use a single route token without whitespace, quotes, semicolons, or Caddy directives.",
      }),
    ),
    description,
  )

const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1"])
const HOST_FLAG_RE = /^--(?:host|hostname|bind|bind-host|listen|listen-host|addr|address)(?:=(.+))?$/
const URL_RE = /\bhttps?:\/\/[^\s'"]+/g

const normalizeHost = (value: string): string => {
  const trimmed = value.trim().replace(/^\[|\]$/g, "")
  if (trimmed === "::") {
    return trimmed
  }
  const portSeparator = trimmed.lastIndexOf(":")
  if (portSeparator > -1 && !trimmed.slice(0, portSeparator).includes(":")) {
    return trimmed.slice(0, portSeparator)
  }
  return trimmed
}

const isLocalhost = (host: string): boolean =>
  LOCALHOST_NAMES.has(normalizeHost(host).toLowerCase())

const localhostOnlyFailure = (value: string, options: { readonly checkUrls: boolean }): true | string => {
  if (options.checkUrls) {
    for (const match of value.matchAll(URL_RE)) {
      try {
        const url = new URL(match[0] as string)
        if (!isLocalhost(url.hostname)) {
          return "Use 127.0.0.1 or localhost for local runtime URLs."
        }
      } catch {
        continue
      }
    }
  }

  const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]?.replace(/^['"]|['"]$/g, "") ?? ""
    const flag = HOST_FLAG_RE.exec(token)
    if (!flag) {
      continue
    }
    const host = flag[1] ?? tokens[index + 1]?.replace(/^['"]|['"]$/g, "")
    if (host && !isLocalhost(host)) {
      return "Use 127.0.0.1 or localhost for explicit host/bind flags."
    }
  }

  return true
}

const LocalhostOnlyString = (description: string, identifier: string) =>
  schemaDoc(
    Schema.String.check(
      Schema.isMinLength(1, { message: "Must not be empty." }),
      Schema.makeFilter<string>(
        (value) => localhostOnlyFailure(value, { checkUrls: identifier !== "localhostOnlyCommand" }),
        { identifier },
      ),
    ),
    description,
  )

const CommandString = LocalhostOnlyString(
  "Shell command used to start a managed component. Network bindings must target 127.0.0.1 or localhost.",
  "localhostOnlyCommand",
)

const HealthCheck = LocalhostOnlyString(
  "HTTP URL or command health check for a managed component. Network checks must target 127.0.0.1 or localhost.",
  "localhostOnlyHealthCheck",
)

const Port = schemaDoc(
  Schema.Number.check(
    Schema.makeFilter<number>(
      (value) => Number.isInteger(value) ? true : "Port must be an integer.",
      { identifier: "integerPort" },
    ),
    Schema.isGreaterThanOrEqualTo(1, { message: "Port must be greater than zero." }),
    Schema.isLessThanOrEqualTo(65535, { message: "Port must be at most 65535." }),
  ),
  "Concrete TCP port reserved by rigd for a managed component.",
)

const TimeoutSeconds = schemaDoc(
  Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(1, { message: "Timeout must be at least one second." }),
  ),
  "Seconds to wait for a managed component to become healthy.",
)

const StringMap = Schema.Record(
  Schema.String,
  fieldDoc(Schema.String, "String value available to the component process environment."),
)

const HooksSchema = Schema.Struct({
  preStart: fieldDoc(Schema.optionalKey(Schema.String), "Command to run before the component starts."),
  postStart: fieldDoc(Schema.optionalKey(Schema.String), "Command to run after the component is healthy."),
  preStop: fieldDoc(Schema.optionalKey(Schema.String), "Command to run before stopping the component."),
  postStop: fieldDoc(Schema.optionalKey(Schema.String), "Command to run after the component is stopped."),
})

const TopLevelHooksSchema = Schema.Struct({
  preStart: fieldDoc(Schema.optionalKey(Schema.String), "Command to run before any component starts."),
  postStart: fieldDoc(Schema.optionalKey(Schema.String), "Command to run after all components are healthy."),
  preStop: fieldDoc(Schema.optionalKey(Schema.String), "Command to run before stopping project components."),
  postStop: fieldDoc(Schema.optionalKey(Schema.String), "Command to run after all project components are stopped."),
})

type RigHooks = Schema.Schema.Type<typeof HooksSchema>
type RigTopLevelHooks = Schema.Schema.Type<typeof TopLevelHooksSchema>

const DaemonSchema = Schema.Struct({
  enabled: fieldDoc(Schema.optionalKey(Schema.Boolean), "Whether this lane should install a launchd daemon."),
  keepAlive: fieldDoc(Schema.optionalKey(Schema.Boolean), "Whether launchd should restart the lane when it exits."),
})

const ProxySchema = Schema.Struct({
  upstream: fieldDoc(ComponentName, "Managed component that receives reverse proxy traffic for this lane."),
})

const ProviderId = schemaDoc(
  Schema.String.check(Schema.isMinLength(1, { message: "Provider id must not be empty." })),
  "Provider id selected for a provider family. Bundled and future plugin providers use the same id shape.",
)

const LaneProvidersSchema = Schema.Struct({
  processSupervisor: fieldDoc(
    Schema.optionalKey(ProviderId),
    "Process supervisor provider id for this lane. Defaults to core rigd; launchd is a bundled first-party plugin.",
  ),
})

const CommonComponentFields = {
  env: fieldDoc(Schema.optionalKey(StringMap), "Inline environment variables applied to this component."),
  envFile: fieldDoc(Schema.optionalKey(Schema.String), "Env file applied to this component."),
  hooks: fieldDoc(Schema.optionalKey(HooksSchema), "Lifecycle hooks applied to this component."),
}

export const RigManagedComponentSchema = Schema.Struct({
  mode: fieldDoc(Schema.Literal("managed"), "Marks this component as a supervised long-running runtime."),
  command: fieldDoc(CommandString, "Command used to start the managed component."),
  port: fieldDoc(Schema.optionalKey(Port), "Optional concrete port required by this component."),
  health: fieldDoc(Schema.optionalKey(HealthCheck), "Optional health check used for readiness and status."),
  readyTimeout: fieldDoc(Schema.optionalKey(TimeoutSeconds), "Optional readiness timeout in seconds."),
  dependsOn: fieldDoc(
    Schema.optionalKey(Schema.Array(ComponentName)),
    "Managed component names that must start before this component and stop after it.",
  ),
  ...CommonComponentFields,
})

export const RigInstalledComponentSchema = Schema.Struct({
  mode: fieldDoc(Schema.Literal("installed"), "Marks this component as an installed executable surface."),
  entrypoint: NonEmptyString("Executable entrypoint or source file used for installation."),
  build: fieldDoc(Schema.optionalKey(Schema.String), "Optional build command for producing the installed artifact."),
  installName: fieldDoc(Schema.optionalKey(ComponentName), "Optional executable name to install instead of the component key."),
  ...CommonComponentFields,
})

export const RigSqliteComponentSchema = Schema.Struct({
  uses: fieldDoc(Schema.Literal("sqlite"), "Uses the bundled SQLite component plugin."),
  path: fieldDoc(
    Schema.optionalKey(NonEmptyString("SQLite database file path.")),
    "Optional SQLite database file path. Defaults to ${dataRoot}/sqlite/<component>.sqlite.",
  ),
})

export const RigConvexComponentSchema = Schema.Struct({
  uses: fieldDoc(Schema.Literal("convex"), "Uses the bundled Convex Local component plugin."),
  command: fieldDoc(Schema.optionalKey(CommandString), "Optional command override for the Convex Local process."),
  port: fieldDoc(Schema.optionalKey(Port), "Optional concrete port required by the Convex Local cloud API."),
  sitePort: fieldDoc(Schema.optionalKey(Port), "Optional concrete port required by the Convex Local site proxy."),
  health: fieldDoc(Schema.optionalKey(HealthCheck), "Optional Convex Local health check override."),
  readyTimeout: fieldDoc(Schema.optionalKey(TimeoutSeconds), "Optional readiness timeout in seconds."),
  dependsOn: fieldDoc(
    Schema.optionalKey(Schema.Array(ComponentName)),
    "Component names that must start before Convex Local and stop after it.",
  ),
  ...CommonComponentFields,
})

export const RigPostgresComponentSchema = Schema.Struct({
  uses: fieldDoc(Schema.Literal("postgres"), "Uses the bundled Postgres component plugin."),
  command: fieldDoc(Schema.optionalKey(CommandString), "Optional command override for the Postgres process."),
  port: fieldDoc(Schema.optionalKey(Port), "Optional concrete port required by Postgres."),
  health: fieldDoc(Schema.optionalKey(HealthCheck), "Optional Postgres health check override."),
  readyTimeout: fieldDoc(Schema.optionalKey(TimeoutSeconds), "Optional readiness timeout in seconds."),
  dependsOn: fieldDoc(
    Schema.optionalKey(Schema.Array(ComponentName)),
    "Component names that must start before Postgres and stop after it.",
  ),
  ...CommonComponentFields,
})

export const RigComponentSchema = Schema.Union([
  RigManagedComponentSchema,
  RigInstalledComponentSchema,
  RigSqliteComponentSchema,
  RigConvexComponentSchema,
  RigPostgresComponentSchema,
])

const LaneComponentOverrideSchema = Schema.Struct({
  command: fieldDoc(Schema.optionalKey(CommandString), "Lane-specific managed command override."),
  port: fieldDoc(Schema.optionalKey(Port), "Lane-specific managed port override."),
  sitePort: fieldDoc(Schema.optionalKey(Port), "Lane-specific Convex Local site proxy port override."),
  health: fieldDoc(Schema.optionalKey(HealthCheck), "Lane-specific managed health check override."),
  readyTimeout: fieldDoc(Schema.optionalKey(TimeoutSeconds), "Lane-specific managed readiness timeout override."),
  dependsOn: fieldDoc(Schema.optionalKey(Schema.Array(ComponentName)), "Lane-specific managed dependency override."),
  entrypoint: fieldDoc(Schema.optionalKey(Schema.String), "Lane-specific installed entrypoint override."),
  build: fieldDoc(Schema.optionalKey(Schema.String), "Lane-specific installed build command override."),
  installName: fieldDoc(Schema.optionalKey(ComponentName), "Lane-specific installed executable name override."),
  path: fieldDoc(Schema.optionalKey(Schema.String), "Lane-specific SQLite database file path override."),
  env: fieldDoc(Schema.optionalKey(StringMap), "Lane-specific inline environment variables for this component."),
  envFile: fieldDoc(Schema.optionalKey(Schema.String), "Lane-specific env file for this component."),
  hooks: fieldDoc(Schema.optionalKey(HooksSchema), "Lane-specific component lifecycle hooks."),
})

const LaneConfigSchema = Schema.Struct({
  components: fieldDoc(
    Schema.optionalKey(Schema.Record(ComponentName, LaneComponentOverrideSchema)),
    "Partial component overrides for this lane, keyed by shared component name.",
  ),
  env: fieldDoc(Schema.optionalKey(StringMap), "Inline environment variables applied to every component in this lane."),
  envFile: fieldDoc(Schema.optionalKey(Schema.String), "Default env file for all components in this lane."),
  proxy: fieldDoc(Schema.optionalKey(ProxySchema), "Reverse proxy settings for this lane."),
  daemon: fieldDoc(Schema.optionalKey(DaemonSchema), "Daemon settings for this lane."),
  providers: fieldDoc(
    Schema.optionalKey(LaneProvidersSchema),
    "Provider ids selected for this lane by provider family.",
  ),
  domain: fieldDoc(Schema.optionalKey(RouteString("Domain override for this lane.")), "Domain override for this lane."),
  subdomain: fieldDoc(Schema.optionalKey(RouteString("Generated deployment subdomain override.")), "Generated deployment subdomain override."),
  deployBranch: fieldDoc(Schema.optionalKey(NonEmptyString("Branch allowed to update this lane when applicable.")), "Branch allowed to update this lane when applicable."),
  providerProfile: fieldDoc(
    Schema.optionalKey(Schema.Union([Schema.Literal("default"), Schema.Literal("stub")])),
    "Provider profile requested for this lane.",
  ),
})

export const RigProjectConfigSchema = Schema.Struct({
  name: fieldDoc(ProjectName, "Stable registered project name."),
  description: fieldDoc(Schema.optionalKey(Schema.String), "Human-readable project description."),
  domain: fieldDoc(Schema.optionalKey(RouteString("Base domain used by live and generated deployment lanes.")), "Base domain used by live and generated deployment lanes."),
  hooks: fieldDoc(Schema.optionalKey(TopLevelHooksSchema), "Project-level lifecycle hooks shared by lanes."),
  components: fieldDoc(
    Schema.Record(ComponentName, RigComponentSchema),
    "Shared component definitions keyed by component name.",
  ),
  local: fieldDoc(Schema.optionalKey(LaneConfigSchema), "Optional working-copy lane overrides."),
  live: fieldDoc(Schema.optionalKey(LaneConfigSchema), "Optional stable built lane overrides."),
  deployments: fieldDoc(Schema.optionalKey(LaneConfigSchema), "Optional generated deployment template overrides."),
})

export type RigProjectConfig = Schema.Schema.Type<typeof RigProjectConfigSchema> & {
  readonly __sourceRepoPath?: string
}
export type RigManagedComponent = Schema.Schema.Type<typeof RigManagedComponentSchema>
export type RigInstalledComponent = Schema.Schema.Type<typeof RigInstalledComponentSchema>
export type RigSqliteComponent = Schema.Schema.Type<typeof RigSqliteComponentSchema>
export type RigConvexComponent = Schema.Schema.Type<typeof RigConvexComponentSchema>
export type RigPostgresComponent = Schema.Schema.Type<typeof RigPostgresComponentSchema>
export type RigComponent = Schema.Schema.Type<typeof RigComponentSchema>

export const RigStatusInputSchema = Schema.Struct({
  project: fieldDoc(ProjectName, "Project selected with --project for a repo-external rig status command."),
  stateRoot: NonEmptyString("Isolated rig state root. Defaults to ~/.rig and never reuses ~/.rig."),
})

export type RigStatusInput = Schema.Schema.Type<typeof RigStatusInputSchema>

export type RigLaneName = "local" | "live" | "deployment"

export interface RigLaneInterpolation {
  readonly lane: RigLaneName
  readonly workspace: string
  readonly dataRoot: string
  readonly deployment: string
  readonly branchSlug: string
  readonly subdomain: string
  readonly assignedPorts: Readonly<Record<string, number>>
  readonly componentProperties: Readonly<Record<string, Readonly<Record<string, string | number>>>>
}

export interface ResolveRigLaneOptions {
  readonly lane: RigLaneName
  readonly workspacePath: string
  readonly dataRoot?: string
  readonly deploymentName?: string
  readonly branchSlug?: string
  readonly subdomain?: string
  readonly assignedPorts?: Readonly<Record<string, number>>
}

export interface ResolvedRigProviders {
  readonly processSupervisor: string
}

export type RigRuntimePlanComponent =
  | {
    readonly name: string
    readonly kind: "managed"
    readonly command: string
    readonly port: number
    readonly health?: string
    readonly readyTimeout: number
    readonly dependsOn?: readonly string[]
    readonly hooks?: ServiceHooks
    readonly envFile?: string
  }
  | {
    readonly name: string
    readonly kind: "installed"
    readonly entrypoint: string
    readonly build?: string
    readonly installName?: string
    readonly hooks?: ServiceHooks
    readonly envFile?: string
  }

export interface RigRuntimePlan {
  readonly project: string
  readonly lane: RigLaneName
  readonly deploymentName: string
  readonly branchSlug: string
  readonly subdomain: string
  readonly workspacePath: string
  readonly dataRoot: string
  readonly providerProfile: "default" | "stub"
  readonly providers: ResolvedRigProviders
  readonly components: readonly RigRuntimePlanComponent[]
  readonly preparedComponents: readonly ResolvedRigPreparedComponent[]
  readonly proxy?: RuntimeEnvironment["proxy"]
  readonly hooks?: TopLevelHooks
  readonly deployBranch?: string
  readonly envFile?: string
  readonly domain?: string
}

export interface ResolvedRigLane {
  readonly project: string
  readonly lane: RigLaneName
  readonly deploymentName: string
  readonly branchSlug: string
  readonly subdomain: string
  readonly workspacePath: string
  readonly dataRoot: string
  readonly sourceRepoPath?: string
  readonly providerProfile: "default" | "stub"
  readonly providers: ResolvedRigProviders
  readonly preparedComponents: readonly ResolvedRigPreparedComponent[]
  readonly runtimePlan: RigRuntimePlan
  readonly environment: RuntimeEnvironment
  readonly v1Config: MigrationRuntimeConfig
}

interface ValidationIssue {
  readonly path: readonly (string | number)[]
  readonly message: string
  readonly code: string
}

const validationError = (
  scope: string,
  error: unknown,
  issues: readonly ValidationIssue[] = [],
): RigConfigValidationError =>
  new RigConfigValidationError(
    `Invalid ${scope}.`,
    "Fix the rig input so it matches the Effect Schema contract.",
    {
      cause: error instanceof Error ? error.message : String(error),
      ...(issues.length > 0 ? { issues } : {}),
    },
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const issue = (
  path: readonly (string | number)[],
  message: string,
  code: string,
): ValidationIssue => ({ path, message, code })

const managedOnlyFields = ["command", "port", "health", "readyTimeout", "dependsOn"] as const
const installedOnlyFields = ["entrypoint", "build", "installName"] as const
const sqliteOnlyFields = ["path"] as const

const componentKind = (value: Record<string, unknown>): "managed" | "installed" | RigComponentPluginId | undefined => {
  if (value.mode === "managed" || value.mode === "installed") {
    return value.mode
  }
  if (value.uses === "sqlite" || value.uses === "convex" || value.uses === "postgres") {
    return value.uses
  }
  return undefined
}

const isRuntimeDependencyKind = (kind: unknown): boolean =>
  kind === "managed" || kind === "sqlite" || kind === "convex" || kind === "postgres"

const isManagedRuntimeKind = (kind: unknown): boolean =>
  kind === "managed" || kind === "convex" || kind === "postgres"

const validateModeFields = (
  value: Record<string, unknown>,
  kind: unknown,
  path: readonly (string | number)[],
): readonly ValidationIssue[] => {
  const issues: ValidationIssue[] = []

  if (hasOwn(value, "mode") && hasOwn(value, "uses")) {
    issues.push(issue(path, "Use either 'mode' or 'uses' for a component, not both.", "invalid_component_source"))
  }

  if (kind === "installed") {
    for (const key of managedOnlyFields) {
      if (hasOwn(value, key)) {
        issues.push(issue([...path, key], `'${key}' is only valid for managed components.`, "invalid_mode_field"))
      }
    }
    for (const key of sqliteOnlyFields) {
      if (hasOwn(value, key)) {
        issues.push(issue([...path, key], `'${key}' is only valid for SQLite components.`, "invalid_mode_field"))
      }
    }
  }

  if (isManagedRuntimeKind(kind)) {
    for (const key of installedOnlyFields) {
      if (hasOwn(value, key)) {
        issues.push(issue([...path, key], `'${key}' is only valid for installed components.`, "invalid_mode_field"))
      }
    }
    for (const key of sqliteOnlyFields) {
      if (hasOwn(value, key)) {
        issues.push(issue([...path, key], `'${key}' is only valid for SQLite components.`, "invalid_mode_field"))
      }
    }
  }

  if (kind === "sqlite") {
    for (const key of managedOnlyFields) {
      if (hasOwn(value, key)) {
        issues.push(issue([...path, key], `'${key}' is only valid for managed components.`, "invalid_mode_field"))
      }
    }
    for (const key of installedOnlyFields) {
      if (hasOwn(value, key)) {
        issues.push(issue([...path, key], `'${key}' is only valid for installed components.`, "invalid_mode_field"))
      }
    }
  }

  return issues
}

const rawConfigIssues = (input: unknown): readonly ValidationIssue[] => {
  if (!isRecord(input)) {
    return []
  }

  const components = input.components
  if (!isRecord(components)) {
    return []
  }

  const issues: ValidationIssue[] = []
  const componentKinds = new Map<string, "managed" | "installed" | RigComponentPluginId | undefined>()

  for (const [name, rawComponent] of Object.entries(components)) {
    if (!isRecord(rawComponent)) {
      continue
    }

    const kind = componentKind(rawComponent)
    componentKinds.set(name, kind)
    issues.push(...validateModeFields(rawComponent, kind, ["components", name]))
  }

  for (const [name, rawComponent] of Object.entries(components)) {
    const kind = isRecord(rawComponent) ? componentKinds.get(name) : undefined
    if (!isRecord(rawComponent) || !isManagedRuntimeKind(kind) || !Array.isArray(rawComponent.dependsOn)) {
      continue
    }

    for (const dependency of rawComponent.dependsOn) {
      const dependencyKind = typeof dependency === "string" ? componentKinds.get(dependency) : undefined
      if (!isRuntimeDependencyKind(dependencyKind)) {
        issues.push(
          issue(
            ["components", name, "dependsOn"],
            `Dependency '${String(dependency)}' must reference a managed or plugin-backed component.`,
            "invalid_dependency",
          ),
        )
      }
    }
  }

  for (const lane of ["local", "live", "deployments"] as const) {
    const rawLane = input[lane]
    if (!isRecord(rawLane)) {
      continue
    }

    const proxy = rawLane.proxy
    if (isRecord(proxy) && typeof proxy.upstream === "string") {
      const upstreamKind = componentKinds.get(proxy.upstream)
      if (!isManagedRuntimeKind(upstreamKind)) {
        issues.push(
          issue(
            [lane, "proxy", "upstream"],
            `Proxy upstream '${proxy.upstream}' must reference a managed or server-backed plugin component.`,
            "invalid_proxy_upstream",
          ),
        )
      }
    }

    if (!isRecord(rawLane.components)) {
      continue
    }

    for (const [name, override] of Object.entries(rawLane.components)) {
      if (!isRecord(override)) {
        continue
      }

      const kind = componentKinds.get(name)
      if (!kind) {
        issues.push(
          issue(
            [lane, "components", name],
            `Lane override references unknown component '${name}'.`,
            "unknown_component",
          ),
        )
        continue
      }

      issues.push(...validateModeFields(override, kind, [lane, "components", name]))

      if (isManagedRuntimeKind(kind) && Array.isArray(override.dependsOn)) {
        for (const dependency of override.dependsOn) {
          const dependencyKind = typeof dependency === "string" ? componentKinds.get(dependency) : undefined
          if (!isRuntimeDependencyKind(dependencyKind)) {
            issues.push(
              issue(
                [lane, "components", name, "dependsOn"],
                `Dependency '${String(dependency)}' must reference a managed or plugin-backed component.`,
                "invalid_dependency",
              ),
            )
          }
        }
      }
    }
  }

  return issues
}

export const decodeRigProjectConfig = (input: unknown) => {
  const issues = rawConfigIssues(input)
  if (issues.length > 0) {
    return Effect.fail(validationError("rig project config", "rig config contains invalid mode-specific fields.", issues))
  }

  return Schema.decodeUnknownEffect(RigProjectConfigSchema)(input).pipe(
    Effect.mapError((error) => validationError("rig project config", error)),
  )
}

export const decodeRigStatusInput = (input: unknown) =>
  Schema.decodeUnknownEffect(RigStatusInputSchema)(input).pipe(
    Effect.mapError((error) => validationError("rig status input", error)),
  )

const laneConfigFor = (config: RigProjectConfig, lane: RigLaneName) =>
  lane === "local" ? config.local : lane === "live" ? config.live : config.deployments

const resolveLaneProviders = (
  laneConfig: ReturnType<typeof laneConfigFor>,
): ResolvedRigProviders => {
  const providerProfile = laneConfig?.providerProfile ?? "default"
  const defaultProcessSupervisor = providerProfile === "stub" ? "stub-process-supervisor" : "rigd"

  return {
    processSupervisor: laneConfig?.providers?.processSupervisor ?? defaultProcessSupervisor,
  }
}

const interpolationFor = (
  config: RigProjectConfig,
  laneConfig: ReturnType<typeof laneConfigFor>,
  options: ResolveRigLaneOptions,
): RigLaneInterpolation => {
  const deployment = options.deploymentName ?? (options.lane === "deployment" ? options.branchSlug ?? "preview" : options.lane)
  const branchSlug = options.branchSlug ?? deployment
  const rawSubdomain = options.subdomain ?? laneConfig?.subdomain ?? branchSlug

  const base = {
    lane: options.lane,
    workspace: options.workspacePath,
    dataRoot: options.dataRoot ?? `${options.workspacePath}/.rig-data`,
    deployment,
    branchSlug,
    subdomain: branchSlug,
    assignedPorts: options.assignedPorts ?? {},
    componentProperties: {},
  }

  return {
    ...base,
    subdomain: interpolateString(rawSubdomain, base),
  }
}

const interpolateString = (value: string, interpolation: RigLaneInterpolation): string =>
  value.replace(/\$\{([^}]+)\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim()
    if (key === "lane") return interpolation.lane
    if (key === "workspace") return interpolation.workspace
    if (key === "dataRoot") return interpolation.dataRoot
    if (key === "deployment") return interpolation.deployment
    if (key === "branchSlug") return interpolation.branchSlug
    if (key === "subdomain") return interpolation.subdomain
    const [component, property, ...rest] = key.split(".")
    if (component && property && rest.length === 0) {
      const componentValue = interpolation.componentProperties[component]?.[property]
      if (componentValue !== undefined) {
        return String(componentValue)
      }
    }
    if (key.startsWith("ports.")) {
      const component = key.slice("ports.".length)
      return String(interpolation.assignedPorts[component] ?? "")
    }
    if (key.startsWith("port.")) {
      const component = key.slice("port.".length)
      return String(interpolation.assignedPorts[component] ?? "")
    }
    if (key.endsWith(".port")) {
      const component = key.slice(0, -".port".length)
      return String(interpolation.assignedPorts[component] ?? "")
    }
    return ""
  })

const interpolateOptional = (
  value: string | undefined,
  interpolation: RigLaneInterpolation,
): string | undefined => value === undefined ? undefined : interpolateString(value, interpolation)

const interpolateHooks = (
  hooks: RigHooks | undefined,
  interpolation: RigLaneInterpolation,
): ServiceHooks | undefined => {
  if (!hooks) {
    return undefined
  }

  return {
    ...(hooks.preStart !== undefined ? { preStart: interpolateString(hooks.preStart, interpolation) } : {}),
    ...(hooks.postStart !== undefined ? { postStart: interpolateString(hooks.postStart, interpolation) } : {}),
    ...(hooks.preStop !== undefined ? { preStop: interpolateString(hooks.preStop, interpolation) } : {}),
    ...(hooks.postStop !== undefined ? { postStop: interpolateString(hooks.postStop, interpolation) } : {}),
  }
}

const interpolateTopLevelHooks = (
  hooks: RigTopLevelHooks | undefined,
  interpolation: RigLaneInterpolation,
): TopLevelHooks | undefined => {
  if (!hooks) {
    return undefined
  }

  return {
    ...(hooks.preStart !== undefined ? { preStart: interpolateString(hooks.preStart, interpolation) } : {}),
    ...(hooks.postStart !== undefined ? { postStart: interpolateString(hooks.postStart, interpolation) } : {}),
    ...(hooks.preStop !== undefined ? { preStop: interpolateString(hooks.preStop, interpolation) } : {}),
    ...(hooks.postStop !== undefined ? { postStop: interpolateString(hooks.postStop, interpolation) } : {}),
  }
}

const resolvePort = (
  name: string,
  value: number | undefined,
  interpolation: RigLaneInterpolation,
): number | undefined =>
  interpolation.lane === "deployment"
    ? interpolation.assignedPorts[name] ?? value
    : value ?? interpolation.assignedPorts[name]

const interpolationWithPort = (
  interpolation: RigLaneInterpolation,
  name: string,
  port: number,
): RigLaneInterpolation => ({
  ...interpolation,
  assignedPorts: {
    ...interpolation.assignedPorts,
    [name]: port,
  },
})

const interpolationWithComponentProperty = (
  interpolation: RigLaneInterpolation,
  name: string,
  properties: Readonly<Record<string, string | number>>,
): RigLaneInterpolation => ({
  ...interpolation,
  componentProperties: {
    ...interpolation.componentProperties,
    [name]: {
      ...interpolation.componentProperties[name],
      ...properties,
    },
  },
  assignedPorts: typeof properties.port === "number"
    ? {
      ...interpolation.assignedPorts,
      [name]: properties.port,
    }
    : interpolation.assignedPorts,
})

export const resolveRigLane = (
  config: RigProjectConfig,
  options: ResolveRigLaneOptions,
): Effect.Effect<ResolvedRigLane, RigConfigValidationError> =>
  Effect.gen(function* () {
    const laneConfig = laneConfigFor(config, options.lane)
    let interpolation = interpolationFor(config, laneConfig, options)
    const providers = resolveLaneProviders(laneConfig)
    const preparedComponents: ResolvedRigPreparedComponent[] = []
    const pluginResults = new Map<string, ReturnType<typeof resolveRigComponentPlugin>>()
    const services: RuntimeEnvironment["services"] = []
    const runtimePlanComponents: RigRuntimePlanComponent[] = []

    for (const [name, component] of Object.entries(config.components)) {
      if (!("uses" in component)) {
        continue
      }

      const override = laneConfig?.components?.[name]
      const componentPath = "path" in component ? component.path : undefined
      const componentCommand = "command" in component ? component.command : undefined
      const componentHealth = "health" in component ? component.health : undefined
      const componentReadyTimeout = "readyTimeout" in component ? component.readyTimeout : undefined
      const componentDependsOn = "dependsOn" in component ? component.dependsOn : undefined
      const port = component.uses === "convex" || component.uses === "postgres"
        ? resolvePort(name, override?.port ?? component.port, interpolation)
        : undefined
      const sitePort = component.uses === "convex" && port !== undefined
        ? resolvePort(`${name}.site`, override?.sitePort ?? component.sitePort, interpolation) ?? port + 1
        : undefined
      if ((component.uses === "convex" || component.uses === "postgres") && port === undefined) {
        return yield* Effect.fail(
          validationError(
            "rig lane resolution",
            `${component.uses} component '${name}' requires a port or assigned port.`,
            [issue(["components", name, "port"], `${component.uses} components need a concrete or assigned port.`, "missing_port")],
          ),
        )
      }
      const resolvedPlugin = component.uses === "sqlite"
        ? resolveRigComponentPlugin({
          uses: "sqlite",
          componentName: name,
          dataRoot: interpolation.dataRoot,
          ...(override?.path ?? componentPath ? { configuredPath: (override?.path ?? componentPath) as string } : {}),
          interpolate: (value) => interpolateString(value, interpolation),
        })
        : component.uses === "convex"
          ? resolveRigComponentPlugin({
            uses: "convex",
            componentName: name,
            dataRoot: interpolation.dataRoot,
            workspacePath: interpolation.workspace,
            port: port as number,
            sitePort: sitePort as number,
            ...((override?.command ?? componentCommand) ? { command: (override?.command ?? componentCommand) as string } : {}),
            ...((override?.health ?? componentHealth) ? { health: (override?.health ?? componentHealth) as string } : {}),
            readyTimeout: override?.readyTimeout ?? componentReadyTimeout,
            ...((override?.dependsOn ?? componentDependsOn) ? { dependsOn: override?.dependsOn ?? componentDependsOn } : {}),
            interpolate: (value) => interpolateString(value, interpolationWithComponentProperty(interpolation, name, {
              port: port as number,
              sitePort: sitePort as number,
              url: `http://127.0.0.1:${port as number}`,
              siteUrl: `http://127.0.0.1:${sitePort as number}`,
              stateDir: `${interpolation.workspace}/.convex/local/default`,
            })),
          })
          : resolveRigComponentPlugin({
            uses: "postgres",
            componentName: name,
            dataRoot: interpolation.dataRoot,
            port: port as number,
            ...((override?.command ?? componentCommand) ? { command: (override?.command ?? componentCommand) as string } : {}),
            ...((override?.health ?? componentHealth) ? { health: (override?.health ?? componentHealth) as string } : {}),
            readyTimeout: override?.readyTimeout ?? componentReadyTimeout,
            ...((override?.dependsOn ?? componentDependsOn) ? { dependsOn: override?.dependsOn ?? componentDependsOn } : {}),
            interpolate: (value) => interpolateString(value, interpolationWithComponentProperty(interpolation, name, {
              port: port as number,
              dataDir: `${interpolation.dataRoot}/postgres/${name}`,
            })),
          })
      pluginResults.set(name, resolvedPlugin)
      preparedComponents.push(...resolvedPlugin.preparedComponents)
      interpolation = interpolationWithComponentProperty(interpolation, name, resolvedPlugin.properties)
    }

    const isManagedServiceDependency = (dependency: string): boolean => {
      const dependencyComponent = config.components[dependency]
      return (
        dependencyComponent !== undefined &&
        "mode" in dependencyComponent &&
        dependencyComponent.mode === "managed"
      ) || (pluginResults.get(dependency)?.managedComponents?.length ?? 0) > 0
    }

    for (const [name, component] of Object.entries(config.components)) {
      const override = laneConfig?.components?.[name]

      if ("mode" in component && component.mode === "managed") {
        const port = resolvePort(name, override?.port ?? component.port, interpolation)
        if (port === undefined) {
          return yield* Effect.fail(
            validationError(
              "rig lane resolution",
              `Managed component '${name}' requires a port or assigned port.`,
              [issue(["components", name, "port"], "Managed components need a concrete or assigned port.", "missing_port")],
            ),
          )
        }
        const componentInterpolation = interpolationWithPort(interpolation, name, port)
        const command = interpolateString(override?.command ?? component.command, componentInterpolation)
        const managedDependencies = (override?.dependsOn ?? component.dependsOn)?.filter(isManagedServiceDependency)
        const hooks = interpolateHooks(override?.hooks ?? component.hooks, componentInterpolation)
        const envFile = override?.envFile ?? component.envFile ?? laneConfig?.envFile
          ? interpolateString((override?.envFile ?? component.envFile ?? laneConfig?.envFile) as string, componentInterpolation)
          : undefined
        const health = override?.health ?? component.health
          ? interpolateString((override?.health ?? component.health) as string, componentInterpolation)
          : undefined
        const readyTimeout = override?.readyTimeout ?? component.readyTimeout ?? 30

        services.push({
          name,
          type: "server",
          command,
          port,
          ...(health ? { healthCheck: health } : {}),
          readyTimeout,
          ...(managedDependencies && managedDependencies.length > 0 ? { dependsOn: managedDependencies } : {}),
          ...(hooks ? { hooks } : {}),
          ...(envFile ? { envFile } : {}),
        })
        runtimePlanComponents.push({
          name,
          kind: "managed",
          command,
          port,
          ...(health ? { health } : {}),
          readyTimeout,
          ...(managedDependencies && managedDependencies.length > 0 ? { dependsOn: managedDependencies } : {}),
          ...(hooks ? { hooks } : {}),
          ...(envFile ? { envFile } : {}),
        })
        interpolation = componentInterpolation
        continue
      }

      if ("uses" in component) {
        const pluginResult = pluginResults.get(name)
        for (const managed of pluginResult?.managedComponents ?? []) {
          const managedDependencies = managed.dependsOn?.filter(isManagedServiceDependency)
          const hooks = "hooks" in component ? interpolateHooks(override?.hooks ?? component.hooks, interpolation) : undefined
          const envFile = "envFile" in component && (override?.envFile ?? component.envFile ?? laneConfig?.envFile)
            ? interpolateString((override?.envFile ?? component.envFile ?? laneConfig?.envFile) as string, interpolation)
            : undefined
          const readyTimeout = managed.readyTimeout ?? 30
          services.push({
            name: managed.name,
            type: "server",
            command: managed.command,
            port: managed.port,
            ...(managed.health ? { healthCheck: managed.health } : {}),
            readyTimeout,
            ...(managedDependencies && managedDependencies.length > 0 ? { dependsOn: managedDependencies } : {}),
            ...(hooks ? { hooks } : {}),
            ...(envFile ? { envFile } : {}),
          })
          runtimePlanComponents.push({
            name: managed.name,
            kind: "managed",
            command: managed.command,
            port: managed.port,
            ...(managed.health ? { health: managed.health } : {}),
            readyTimeout,
            ...(managedDependencies && managedDependencies.length > 0 ? { dependsOn: managedDependencies } : {}),
            ...(hooks ? { hooks } : {}),
            ...(envFile ? { envFile } : {}),
          })
        }
        continue
      }

      if (!("mode" in component) || component.mode !== "installed") {
        continue
      }

      const installName = override?.installName ?? component.installName
      const entrypoint = interpolateString(override?.entrypoint ?? component.entrypoint, interpolation)
      const build = override?.build ?? component.build
        ? interpolateString((override?.build ?? component.build) as string, interpolation)
        : undefined
      const hooks = interpolateHooks(override?.hooks ?? component.hooks, interpolation)
      const envFile = override?.envFile ?? component.envFile ?? laneConfig?.envFile
        ? interpolateString((override?.envFile ?? component.envFile ?? laneConfig?.envFile) as string, interpolation)
        : undefined

      services.push({
        name: installName ?? name,
        type: "bin",
        entrypoint,
        ...(build ? { build } : {}),
        ...(hooks ? { hooks } : {}),
        ...(envFile ? { envFile } : {}),
      })
      runtimePlanComponents.push({
        name,
        kind: "installed",
        entrypoint,
        ...(build ? { build } : {}),
        ...(installName ? { installName } : {}),
        ...(hooks ? { hooks } : {}),
        ...(envFile ? { envFile } : {}),
      })
    }

    const envFile = laneConfig?.envFile ? interpolateString(laneConfig.envFile, interpolation) : undefined
    const domain = interpolateOptional(laneConfig?.domain ?? config.domain, interpolation)
    const hooks = interpolateTopLevelHooks(config.hooks, interpolation)
    const deployBranch = laneConfig?.deployBranch ? interpolateString(laneConfig.deployBranch, interpolation) : undefined

    const environment: RuntimeEnvironment = {
      ...(deployBranch ? { deployBranch } : {}),
      ...(envFile ? { envFile } : {}),
      ...(laneConfig?.proxy ? { proxy: { upstream: laneConfig.proxy.upstream } } : {}),
      services,
    }

    const v1Config: MigrationRuntimeConfig = {
      name: config.name,
      ...(config.description ? { description: config.description } : {}),
      version: "0.0.0",
      ...(domain ? { domain } : {}),
      ...(hooks ? { hooks } : {}),
      environments: {
        [options.lane === "local" ? "dev" : "prod"]: environment,
      },
      ...(laneConfig?.daemon
        ? { daemon: { enabled: laneConfig.daemon.enabled ?? false, keepAlive: laneConfig.daemon.keepAlive ?? false } satisfies DaemonConfig }
        : {}),
    }

    const runtimePlan: RigRuntimePlan = {
      project: config.name,
      lane: options.lane,
      deploymentName: interpolation.deployment,
      branchSlug: interpolation.branchSlug,
      subdomain: interpolation.subdomain,
      workspacePath: interpolation.workspace,
      dataRoot: interpolation.dataRoot,
      providerProfile: laneConfig?.providerProfile ?? "default",
      providers,
      components: runtimePlanComponents,
      preparedComponents,
      ...(environment.proxy ? { proxy: environment.proxy } : {}),
      ...(hooks ? { hooks } : {}),
      ...(deployBranch ? { deployBranch } : {}),
      ...(envFile ? { envFile } : {}),
      ...(domain ? { domain } : {}),
    }

    return {
      project: config.name,
      lane: options.lane,
      deploymentName: interpolation.deployment,
      branchSlug: interpolation.branchSlug,
      subdomain: interpolation.subdomain,
      workspacePath: interpolation.workspace,
      dataRoot: interpolation.dataRoot,
      ...(config.__sourceRepoPath ? { sourceRepoPath: config.__sourceRepoPath } : {}),
      providerProfile: laneConfig?.providerProfile ?? "default",
      providers,
      preparedComponents,
      runtimePlan,
      environment,
      v1Config,
    }
  })
