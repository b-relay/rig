import { Effect, Schema } from "effect-v4"

import type { DaemonConfig, Environment, RigConfig, ServiceHooks, TopLevelHooks } from "../schema/config.js"
import { V2ConfigValidationError } from "./errors.js"

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
  "Stable registered project name used for v2 project identity.",
)

const ComponentName = schemaDoc(
  Schema.String.check(
    Schema.isPattern(COMPONENT_NAME_RE, {
      message: "Use lowercase letters, numbers, or hyphens, and start with a letter or number.",
    }),
  ),
  "Stable component key used for process labels, logs, dependency references, and generated service names.",
)

const LocalhostOnlyString = (description: string, identifier: string) =>
  schemaDoc(
    Schema.String.check(
      Schema.isMinLength(1, { message: "Must not be empty." }),
      Schema.makeFilter<string>(
        (value) =>
          value.includes("0.0.0.0")
            ? "Use 127.0.0.1 or localhost, never 0.0.0.0."
            : true,
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

type V2Hooks = Schema.Schema.Type<typeof HooksSchema>
type V2TopLevelHooks = Schema.Schema.Type<typeof TopLevelHooksSchema>

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

export const V2ManagedComponentSchema = Schema.Struct({
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

export const V2InstalledComponentSchema = Schema.Struct({
  mode: fieldDoc(Schema.Literal("installed"), "Marks this component as an installed executable surface."),
  entrypoint: NonEmptyString("Executable entrypoint or source file used for installation."),
  build: fieldDoc(Schema.optionalKey(Schema.String), "Optional build command for producing the installed artifact."),
  installName: fieldDoc(Schema.optionalKey(ComponentName), "Optional executable name to install instead of the component key."),
  ...CommonComponentFields,
})

export const V2ComponentSchema = Schema.Union([
  V2ManagedComponentSchema,
  V2InstalledComponentSchema,
])

const LaneComponentOverrideSchema = Schema.Struct({
  command: fieldDoc(Schema.optionalKey(CommandString), "Lane-specific managed command override."),
  port: fieldDoc(Schema.optionalKey(Port), "Lane-specific managed port override."),
  health: fieldDoc(Schema.optionalKey(HealthCheck), "Lane-specific managed health check override."),
  readyTimeout: fieldDoc(Schema.optionalKey(TimeoutSeconds), "Lane-specific managed readiness timeout override."),
  dependsOn: fieldDoc(Schema.optionalKey(Schema.Array(ComponentName)), "Lane-specific managed dependency override."),
  entrypoint: fieldDoc(Schema.optionalKey(Schema.String), "Lane-specific installed entrypoint override."),
  build: fieldDoc(Schema.optionalKey(Schema.String), "Lane-specific installed build command override."),
  installName: fieldDoc(Schema.optionalKey(ComponentName), "Lane-specific installed executable name override."),
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
  domain: fieldDoc(Schema.optionalKey(Schema.String), "Domain override for this lane."),
  subdomain: fieldDoc(Schema.optionalKey(Schema.String), "Generated deployment subdomain override."),
  deployBranch: fieldDoc(Schema.optionalKey(Schema.String), "Branch allowed to update this lane when applicable."),
  providerProfile: fieldDoc(
    Schema.optionalKey(Schema.Union([Schema.Literal("default"), Schema.Literal("stub")])),
    "Provider profile requested for this lane.",
  ),
})

export const V2ProjectConfigSchema = Schema.Struct({
  name: fieldDoc(ProjectName, "Stable registered project name."),
  description: fieldDoc(Schema.optionalKey(Schema.String), "Human-readable project description."),
  domain: fieldDoc(Schema.optionalKey(Schema.String), "Base domain used by live and generated deployment lanes."),
  hooks: fieldDoc(Schema.optionalKey(TopLevelHooksSchema), "Project-level lifecycle hooks shared by lanes."),
  components: fieldDoc(
    Schema.Record(ComponentName, V2ComponentSchema),
    "Shared component definitions keyed by component name.",
  ),
  local: fieldDoc(Schema.optionalKey(LaneConfigSchema), "Optional working-copy lane overrides."),
  live: fieldDoc(Schema.optionalKey(LaneConfigSchema), "Optional stable built lane overrides."),
  deployments: fieldDoc(Schema.optionalKey(LaneConfigSchema), "Optional generated deployment template overrides."),
})

export type V2ProjectConfig = Schema.Schema.Type<typeof V2ProjectConfigSchema>
export type V2ManagedComponent = Schema.Schema.Type<typeof V2ManagedComponentSchema>
export type V2InstalledComponent = Schema.Schema.Type<typeof V2InstalledComponentSchema>
export type V2Component = Schema.Schema.Type<typeof V2ComponentSchema>

export const V2StatusInputSchema = Schema.Struct({
  project: fieldDoc(ProjectName, "Project selected with --project for a repo-external rig2 status command."),
  stateRoot: NonEmptyString("Isolated v2 state root. Defaults to ~/.rig-v2 and never reuses ~/.rig."),
})

export type V2StatusInput = Schema.Schema.Type<typeof V2StatusInputSchema>

export type V2LaneName = "local" | "live" | "deployment"

export interface V2LaneInterpolation {
  readonly lane: V2LaneName
  readonly workspace: string
  readonly deployment: string
  readonly branchSlug: string
  readonly subdomain: string
  readonly assignedPorts: Readonly<Record<string, number>>
}

export interface ResolveV2LaneOptions {
  readonly lane: V2LaneName
  readonly workspacePath: string
  readonly deploymentName?: string
  readonly branchSlug?: string
  readonly subdomain?: string
  readonly assignedPorts?: Readonly<Record<string, number>>
}

export interface ResolvedV2Providers {
  readonly processSupervisor: string
}

export interface ResolvedV2Lane {
  readonly project: string
  readonly lane: V2LaneName
  readonly deploymentName: string
  readonly branchSlug: string
  readonly subdomain: string
  readonly workspacePath: string
  readonly providerProfile: "default" | "stub"
  readonly providers: ResolvedV2Providers
  readonly environment: Environment
  readonly v1Config: RigConfig
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
): V2ConfigValidationError =>
  new V2ConfigValidationError(
    `Invalid ${scope}.`,
    "Fix the v2 input so it matches the Effect Schema contract.",
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

const validateModeFields = (
  value: Record<string, unknown>,
  mode: unknown,
  path: readonly (string | number)[],
): readonly ValidationIssue[] => {
  const issues: ValidationIssue[] = []

  if (mode === "installed") {
    for (const key of managedOnlyFields) {
      if (hasOwn(value, key)) {
        issues.push(issue([...path, key], `'${key}' is only valid for managed components.`, "invalid_mode_field"))
      }
    }
  }

  if (mode === "managed") {
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
  const componentModes = new Map<string, unknown>()

  for (const [name, rawComponent] of Object.entries(components)) {
    if (!isRecord(rawComponent)) {
      continue
    }

    componentModes.set(name, rawComponent.mode)
    issues.push(...validateModeFields(rawComponent, rawComponent.mode, ["components", name]))
  }

  for (const [name, rawComponent] of Object.entries(components)) {
    if (!isRecord(rawComponent) || rawComponent.mode !== "managed" || !Array.isArray(rawComponent.dependsOn)) {
      continue
    }

    for (const dependency of rawComponent.dependsOn) {
      const dependencyMode = typeof dependency === "string" ? componentModes.get(dependency) : undefined
      if (dependencyMode !== "managed") {
        issues.push(
          issue(
            ["components", name, "dependsOn"],
            `Dependency '${String(dependency)}' must reference a managed component.`,
            "invalid_dependency",
          ),
        )
      }
    }
  }

  for (const lane of ["local", "live", "deployments"] as const) {
    const rawLane = input[lane]
    if (!isRecord(rawLane) || !isRecord(rawLane.components)) {
      continue
    }

    for (const [name, override] of Object.entries(rawLane.components)) {
      if (!isRecord(override)) {
        continue
      }

      const mode = componentModes.get(name)
      if (!mode) {
        issues.push(
          issue(
            [lane, "components", name],
            `Lane override references unknown component '${name}'.`,
            "unknown_component",
          ),
        )
        continue
      }

      issues.push(...validateModeFields(override, mode, [lane, "components", name]))

      if (mode === "managed" && Array.isArray(override.dependsOn)) {
        for (const dependency of override.dependsOn) {
          const dependencyMode = typeof dependency === "string" ? componentModes.get(dependency) : undefined
          if (dependencyMode !== "managed") {
            issues.push(
              issue(
                [lane, "components", name, "dependsOn"],
                `Dependency '${String(dependency)}' must reference a managed component.`,
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

export const decodeV2ProjectConfig = (input: unknown) => {
  const issues = rawConfigIssues(input)
  if (issues.length > 0) {
    return Effect.fail(validationError("v2 project config", "v2 config contains invalid mode-specific fields.", issues))
  }

  return Schema.decodeUnknownEffect(V2ProjectConfigSchema)(input).pipe(
    Effect.mapError((error) => validationError("v2 project config", error)),
  )
}

export const decodeV2StatusInput = (input: unknown) =>
  Schema.decodeUnknownEffect(V2StatusInputSchema)(input).pipe(
    Effect.mapError((error) => validationError("rig2 status input", error)),
  )

const laneConfigFor = (config: V2ProjectConfig, lane: V2LaneName) =>
  lane === "local" ? config.local : lane === "live" ? config.live : config.deployments

const defaultV2Providers: ResolvedV2Providers = {
  processSupervisor: "rigd",
}

const resolveLaneProviders = (
  laneConfig: ReturnType<typeof laneConfigFor>,
): ResolvedV2Providers => ({
  processSupervisor: laneConfig?.providers?.processSupervisor ?? defaultV2Providers.processSupervisor,
})

const interpolationFor = (
  config: V2ProjectConfig,
  laneConfig: ReturnType<typeof laneConfigFor>,
  options: ResolveV2LaneOptions,
): V2LaneInterpolation => {
  const deployment = options.deploymentName ?? (options.lane === "deployment" ? options.branchSlug ?? "preview" : options.lane)
  const branchSlug = options.branchSlug ?? deployment
  const rawSubdomain = options.subdomain ?? laneConfig?.subdomain ?? branchSlug

  const base = {
    lane: options.lane,
    workspace: options.workspacePath,
    deployment,
    branchSlug,
    subdomain: branchSlug,
    assignedPorts: options.assignedPorts ?? {},
  }

  return {
    ...base,
    subdomain: interpolateString(rawSubdomain, base),
  }
}

const interpolateString = (value: string, interpolation: V2LaneInterpolation): string =>
  value.replace(/\$\{([^}]+)\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim()
    if (key === "lane") return interpolation.lane
    if (key === "workspace") return interpolation.workspace
    if (key === "deployment") return interpolation.deployment
    if (key === "branchSlug") return interpolation.branchSlug
    if (key === "subdomain") return interpolation.subdomain
    if (key.startsWith("ports.")) {
      const component = key.slice("ports.".length)
      return String(interpolation.assignedPorts[component] ?? "")
    }
    if (key.startsWith("port.")) {
      const component = key.slice("port.".length)
      return String(interpolation.assignedPorts[component] ?? "")
    }
    return ""
  })

const interpolateOptional = (
  value: string | undefined,
  interpolation: V2LaneInterpolation,
): string | undefined => value === undefined ? undefined : interpolateString(value, interpolation)

const interpolateHooks = (
  hooks: V2Hooks | undefined,
  interpolation: V2LaneInterpolation,
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
  hooks: V2TopLevelHooks | undefined,
  interpolation: V2LaneInterpolation,
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
  interpolation: V2LaneInterpolation,
): number | undefined =>
  interpolation.lane === "deployment"
    ? interpolation.assignedPorts[name] ?? value
    : value ?? interpolation.assignedPorts[name]

export const resolveV2Lane = (
  config: V2ProjectConfig,
  options: ResolveV2LaneOptions,
): Effect.Effect<ResolvedV2Lane, V2ConfigValidationError> =>
  Effect.gen(function* () {
    const laneConfig = laneConfigFor(config, options.lane)
    const interpolation = interpolationFor(config, laneConfig, options)
    const providers = resolveLaneProviders(laneConfig)
    const services: Environment["services"] = []

    for (const [name, component] of Object.entries(config.components)) {
      const override = laneConfig?.components?.[name]

      if (component.mode === "managed") {
        const command = interpolateString(override?.command ?? component.command, interpolation)
        const port = resolvePort(name, override?.port ?? component.port, interpolation)
        if (port === undefined) {
          return yield* Effect.fail(
            validationError(
              "v2 lane resolution",
              `Managed component '${name}' requires a port or assigned port.`,
              [issue(["components", name, "port"], "Managed components need a concrete or assigned port.", "missing_port")],
            ),
          )
        }

        services.push({
          name,
          type: "server",
          command,
          port,
          ...(override?.health ?? component.health
            ? { healthCheck: interpolateString((override?.health ?? component.health) as string, interpolation) }
            : {}),
          readyTimeout: override?.readyTimeout ?? component.readyTimeout ?? 30,
          ...(override?.dependsOn ?? component.dependsOn ? { dependsOn: override?.dependsOn ?? component.dependsOn } : {}),
          ...(interpolateHooks(override?.hooks ?? component.hooks, interpolation)
            ? { hooks: interpolateHooks(override?.hooks ?? component.hooks, interpolation) }
            : {}),
          ...(override?.envFile ?? component.envFile ?? laneConfig?.envFile
            ? { envFile: interpolateString((override?.envFile ?? component.envFile ?? laneConfig?.envFile) as string, interpolation) }
            : {}),
        })
        continue
      }

      services.push({
        name: override?.installName ?? component.installName ?? name,
        type: "bin",
        entrypoint: interpolateString(override?.entrypoint ?? component.entrypoint, interpolation),
        ...(override?.build ?? component.build ? { build: interpolateString((override?.build ?? component.build) as string, interpolation) } : {}),
        ...(interpolateHooks(override?.hooks ?? component.hooks, interpolation)
          ? { hooks: interpolateHooks(override?.hooks ?? component.hooks, interpolation) }
          : {}),
        ...(override?.envFile ?? component.envFile ?? laneConfig?.envFile
          ? { envFile: interpolateString((override?.envFile ?? component.envFile ?? laneConfig?.envFile) as string, interpolation) }
          : {}),
      })
    }

    const environment: Environment = {
      ...(laneConfig?.deployBranch ? { deployBranch: interpolateString(laneConfig.deployBranch, interpolation) } : {}),
      ...(laneConfig?.envFile ? { envFile: interpolateString(laneConfig.envFile, interpolation) } : {}),
      ...(laneConfig?.proxy ? { proxy: { upstream: laneConfig.proxy.upstream } } : {}),
      services,
    }

    const v1Config: RigConfig = {
      name: config.name,
      ...(config.description ? { description: config.description } : {}),
      version: "0.0.0",
      ...(interpolateOptional(laneConfig?.domain ?? config.domain, interpolation)
        ? { domain: interpolateOptional(laneConfig?.domain ?? config.domain, interpolation) as string }
        : {}),
      ...(interpolateTopLevelHooks(config.hooks, interpolation)
        ? { hooks: interpolateTopLevelHooks(config.hooks, interpolation) }
        : {}),
      environments: {
        [options.lane === "local" ? "dev" : "prod"]: environment,
      },
      ...(laneConfig?.daemon
        ? { daemon: { enabled: laneConfig.daemon.enabled ?? false, keepAlive: laneConfig.daemon.keepAlive ?? false } satisfies DaemonConfig }
        : {}),
    }

    return {
      project: config.name,
      lane: options.lane,
      deploymentName: interpolation.deployment,
      branchSlug: interpolation.branchSlug,
      subdomain: interpolation.subdomain,
      workspacePath: interpolation.workspace,
      providerProfile: laneConfig?.providerProfile ?? "default",
      providers,
      environment,
      v1Config,
    }
  })
