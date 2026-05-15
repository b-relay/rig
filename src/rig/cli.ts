import { Effect, FileSystem, Layer, Path, Sink, Stdio, Stream, Terminal } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { BunStdio } from "@effect/platform-bun"

import { decodeRigStatusInput, type RigProjectConfig } from "./config.js"
import { RigDeployIntents, type RigDeployTarget } from "./deploy-intent.js"
import { RigDoctor } from "./doctor.js"
import { RigCliArgumentError, unknownToRigCliError } from "./errors.js"
import { RigHomeConfigStore, type RigHomeConfig } from "./home-config.js"
import { RigLifecycle, type RigLifecycleAction, type RigLifecycleLane } from "./lifecycle.js"
import { rigRoot } from "./paths.js"
import { RigProjectConfigLoader } from "./project-config-loader.js"
import {
  RigProjectInitializer,
  type RigInitComponentPluginId,
  type RigInitInstalledComponent,
  type RigInitManagedComponent,
} from "./project-initializer.js"
import { RigProjectLocator } from "./project-locator.js"
import { RigProviderRegistry } from "./provider-contracts.js"
import { Rigd, type RigdWebReadModel } from "./rigd.js"
import { RigLogger, RigRuntime, type RigFoundationState } from "./services.js"

const displayText = (text: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), stdio.stdout({ endOnDone: false }))
  }).pipe(
    Effect.provide(BunStdio.layer),
    Effect.orDie,
  )

const terminal = Terminal.make({
  columns: Effect.succeed(100),
  readInput: Effect.die("rig CLI does not read terminal input yet."),
  readLine: Effect.succeed(""),
  display: displayText,
})

const childProcessSpawner = ChildProcessSpawner.of({
  spawn: () => Effect.die("rig CLI does not spawn child processes yet."),
  exitCode: () => Effect.die("rig CLI does not spawn child processes yet."),
  streamString: () => Stream.empty,
  streamLines: () => Stream.empty,
  lines: () => Effect.succeed([]),
  string: () => Effect.succeed(""),
})

const cliEnvironmentLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Layer.succeed(Terminal.Terminal, terminal),
  Stdio.layerTest({
    args: Effect.succeed([]),
    stdin: Stream.empty,
    stdout: () => Sink.drain,
    stderr: () => Sink.drain,
  }),
  Layer.succeed(ChildProcessSpawner, childProcessSpawner),
)

interface ProjectScopedInput {
  readonly project: string
  readonly lane: RigLifecycleLane
  readonly stateRoot: string
  readonly configPath?: string
}

const formatFoundationStatus = (state: RigFoundationState & { readonly lane: RigLifecycleLane }) => [
  "rig foundation ready",
  `project: ${state.project}`,
  `lane: ${state.lane}`,
  `state root: ${state.stateRoot}`,
  `namespace: ${state.namespace}`,
  `launchd label prefix: ${state.launchdLabelPrefix}`,
].join("\n")

const formatRigdStatus = (input: {
  readonly status: string
  readonly project: string
  readonly deploymentCount: number
}) => [
  "rigd status",
  `rigd: ${input.status}`,
  `project: ${input.project}`,
  `deployments: ${input.deploymentCount}`,
].join("\n")

const formatProjectList = (model: RigdWebReadModel) => {
  const projectLines = model.projects.length === 0
    ? ["projects: none"]
    : [
      "projects:",
      ...model.projects.map((project) => `  ${project.name}`),
    ]
  const deploymentLines = model.deployments.length === 0
    ? ["deployments: none"]
    : [
      "deployments:",
      ...model.deployments.map((deployment) =>
        `  ${deployment.project}/${deployment.name} (${deployment.kind}) profile=${deployment.providerProfile} observed=${deployment.observedAt}`
      ),
    ]

  return [
    "rig projects",
    `rigd: ${model.health.rigd.status}`,
    ...projectLines,
    ...deploymentLines,
  ].join("\n")
}

const projectFlag = Flag.string("project").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Registered project name. Optional inside a managed repo."),
)

const initPathFlag = Flag.string("path").pipe(
  Flag.withDefault("."),
  Flag.withDescription("Project directory where rig should write rig.json."),
)

const initDomainFlag = Flag.string("domain").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Base domain to scaffold into the project config, for example pantry.b-relay.com."),
)

const initProxyFlag = Flag.string("proxy").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Component name to scaffold as the lane proxy upstream, for example web."),
)

const usesFlag = Flag.string("uses").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Comma-separated bundled component plugins to scaffold, for example sqlite,postgres,convex."),
)

const initManagedFlag = Flag.string("managed").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Explicit managed component name to scaffold, for example web."),
)

const initManagedCommandFlag = Flag.string("managed-command").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Command for the explicit managed component."),
)

const initManagedPortFlag = Flag.integer("managed-port").pipe(
  Flag.withDefault(0),
  Flag.withDescription("Optional port for the explicit managed component."),
)

const initManagedHealthFlag = Flag.string("managed-health").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Optional health check for the explicit managed component."),
)

const initInstalledFlag = Flag.string("installed").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Explicit installed component name to scaffold, for example cli."),
)

const initInstalledEntrypointFlag = Flag.string("installed-entrypoint").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Entrypoint for the explicit installed component."),
)

const initInstalledBuildFlag = Flag.string("installed-build").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Optional build command for the explicit installed component."),
)

const initInstalledNameFlag = Flag.string("installed-name").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Optional installed executable name."),
)

const resolveProjectScopedInput = (input: {
  readonly project: string
  readonly lane?: RigLifecycleLane
  readonly stateRoot: string
  readonly configPath?: string
}): Effect.Effect<ProjectScopedInput, RigCliArgumentError, RigProjectLocator> =>
  Effect.gen(function* () {
    const explicitProject = input.project.trim()
    const explicitConfigPath = input.configPath?.trim()
    if (explicitProject.length > 0 && explicitConfigPath) {
      return {
        ...input,
        project: explicitProject,
        configPath: explicitConfigPath,
      }
    }

    const locator = yield* RigProjectLocator
    const locatedResult = yield* locator.inferCurrentProject.pipe(
      Effect.matchEffect({
        onSuccess: (located) => Effect.succeed({ ok: true as const, located }),
        onFailure: (error) => Effect.succeed({ ok: false as const, error }),
      }),
    )
    if (!locatedResult.ok) {
      if (explicitProject.length > 0) {
        return {
          ...input,
          lane: input.lane ?? "local",
          project: explicitProject,
        }
      }
      return yield* Effect.fail(locatedResult.error)
    }
    const located = locatedResult.located
    if (explicitProject.length > 0 && located.name !== explicitProject) {
      return {
        ...input,
        lane: input.lane ?? "local",
        project: explicitProject,
      }
    }

    return {
      ...input,
      lane: input.lane ?? "local",
      project: explicitProject || located.name,
      configPath: explicitConfigPath || located.configPath,
    }
  })

const loadProjectConfig = (input: {
  readonly project: string
  readonly configPath?: string
}): Effect.Effect<RigProjectConfig | undefined, RigCliArgumentError, RigProjectConfigLoader> =>
  Effect.gen(function* () {
    if (!input.configPath) {
      return undefined
    }

    const loader = yield* RigProjectConfigLoader
    const loaded = yield* loader.load({
      project: input.project,
      configPath: input.configPath,
    })
    return loaded.config
  })

const requireProjectConfig = (input: {
  readonly project: string
  readonly configPath?: string
  readonly command: string
}): Effect.Effect<RigProjectConfig, RigCliArgumentError, RigProjectConfigLoader> =>
  Effect.gen(function* () {
    const config = yield* loadProjectConfig(input)
    if (config) {
      return config
    }
    return yield* Effect.fail(
      new RigCliArgumentError(
        `rig ${input.command} requires a rig.json for runtime changes.`,
        "Run the command from a managed repo so Rig can discover project config.",
        { project: input.project, command: input.command },
      ),
    )
  })

const requireConfigPath = (
  input: ProjectScopedInput,
): Effect.Effect<string, RigCliArgumentError> => {
  if (input.configPath && input.configPath.trim().length > 0) {
    return Effect.succeed(input.configPath.trim())
  }

  return Effect.fail(
    new RigCliArgumentError(
      "rig config commands require a rig.json path.",
      "Run the command from a managed repo so Rig can discover project config.",
      { project: input.project },
    ),
  )
}

const parseInitUses = (raw: string): Effect.Effect<readonly RigInitComponentPluginId[], RigCliArgumentError> => {
  const selected: RigInitComponentPluginId[] = []
  for (const candidate of raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0)) {
    if (candidate !== "sqlite" && candidate !== "postgres" && candidate !== "convex") {
      return Effect.fail(
        new RigCliArgumentError(
          `Unknown init component plugin '${candidate}'.`,
          "Use --uses with a comma-separated list containing sqlite, postgres, or convex.",
          { uses: raw, allowed: ["sqlite", "postgres", "convex"] },
        ),
      )
    }
    if (!selected.includes(candidate)) {
      selected.push(candidate)
    }
  }
  return Effect.succeed(selected)
}

const optionalText = (raw: string): string | undefined => {
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const initProviderProfile = (): "default" | "stub" =>
  process.env.RIG_PROVIDER_PROFILE?.trim() === "stub" ? "stub" : "default"

const parseInitManagedComponent = (input: {
  readonly managed: string
  readonly managedCommand: string
  readonly managedPort: number
  readonly managedHealth: string
}): Effect.Effect<RigInitManagedComponent | undefined, RigCliArgumentError> => {
  const name = optionalText(input.managed)
  const command = optionalText(input.managedCommand)
  const health = optionalText(input.managedHealth)
  const hasManagedInput = Boolean(name || command || health || input.managedPort !== 0)
  if (!hasManagedInput) {
    return Effect.succeed(undefined)
  }
  if (!name || !command) {
    return Effect.fail(
      new RigCliArgumentError(
        "Managed component scaffolding requires --managed and --managed-command.",
        "Pass both flags, or omit all managed component scaffold flags.",
      ),
    )
  }
  if (input.managedPort < 0 || input.managedPort > 65535) {
    return Effect.fail(
      new RigCliArgumentError(
        "Managed component port must be between 1 and 65535 when provided.",
        "Pass --managed-port with a valid TCP port, or omit it.",
        { port: input.managedPort },
      ),
    )
  }

  return Effect.succeed({
    name,
    command,
    ...(input.managedPort > 0 ? { port: input.managedPort } : {}),
    ...(health ? { health } : {}),
  })
}

const parseInitInstalledComponent = (input: {
  readonly installed: string
  readonly installedEntrypoint: string
  readonly installedBuild: string
  readonly installedName: string
}): Effect.Effect<RigInitInstalledComponent | undefined, RigCliArgumentError> => {
  const name = optionalText(input.installed)
  const entrypoint = optionalText(input.installedEntrypoint)
  const build = optionalText(input.installedBuild)
  const installName = optionalText(input.installedName)
  const hasInstalledInput = Boolean(name || entrypoint || build || installName)
  if (!hasInstalledInput) {
    return Effect.succeed(undefined)
  }
  if (!name || !entrypoint) {
    return Effect.fail(
      new RigCliArgumentError(
        "Installed component scaffolding requires --installed and --installed-entrypoint.",
        "Pass both flags, or omit all installed component scaffold flags.",
      ),
    )
  }

  return Effect.succeed({
    name,
    entrypoint,
    ...(build ? { build } : {}),
    ...(installName ? { installName } : {}),
  })
}

const runLifecycleAction = (
  action: RigLifecycleAction,
  input: {
    readonly project: string
    readonly lane?: RigLifecycleLane
    readonly stateRoot: string
    readonly follow?: boolean
    readonly lines?: number
    readonly structured?: boolean
    readonly configPath?: string
    readonly config?: RigProjectConfig
  },
) =>
  Effect.gen(function* () {
    const decoded = yield* decodeRigStatusInput({
      project: input.project,
      stateRoot: input.stateRoot,
    })
    const config = input.config ?? (yield* loadProjectConfig({
      project: decoded.project,
      configPath: input.configPath,
    }))
    if ((action === "up" || action === "down" || action === "restart") && !config) {
      return yield* Effect.fail(
        new RigCliArgumentError(
          `rig ${action} requires a rig.json for runtime changes.`,
          "Run the command from a managed repo so Rig can discover project config.",
          { project: decoded.project, action },
        ),
      )
    }
    const lifecycle = yield* RigLifecycle
    yield* lifecycle.run({
      action,
      project: decoded.project,
      lane: input.lane ?? "local",
      stateRoot: decoded.stateRoot,
      ...(config ? { config } : {}),
      ...(input.follow !== undefined ? { follow: input.follow } : {}),
      ...(input.lines !== undefined ? { lines: input.lines } : {}),
      ...(input.structured !== undefined ? { structured: input.structured } : {}),
    })
  })

const lifecycleCommand = (action: RigLifecycleAction, description: string) =>
  Command.make(
    action,
    {
      project: projectFlag,
    },
    (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveProjectScopedInput({
          ...input,
          stateRoot: rigRoot(),
        })
        yield* runLifecycleAction(action, resolved)
      }),
  ).pipe(Command.withDescription(description))

const logsCommand = Command.make(
  "logs",
  {
    project: projectFlag,
    follow: Flag.boolean("follow").pipe(Flag.withDescription("Follow log output.")),
    lines: Flag.integer("lines").pipe(
      Flag.withDefault(50),
      Flag.withDescription("Number of log lines to read."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const resolved = yield* resolveProjectScopedInput({
        ...input,
        stateRoot: rigRoot(),
      })
      yield* runLifecycleAction("logs", {
        project: resolved.project,
        stateRoot: resolved.stateRoot,
        ...(resolved.configPath ? { configPath: resolved.configPath } : {}),
        follow: input.follow,
        lines: input.lines,
      })
    }),
).pipe(Command.withDescription("Inspect logs for an existing Rig Target."))

const downCommand = Command.make(
  "down",
  {
    project: projectFlag,
    destroy: Flag.boolean("destroy").pipe(
      Flag.withDescription("Reserved for future Preview cleanup; rejected for normal Targets."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      if (input.destroy) {
        return yield* Effect.fail(
          new RigCliArgumentError(
            "down --destroy is reserved for generated deployments.",
            "Use plain 'rig down' for local/live lanes until generated deployments are available.",
          ),
        )
      }

      const resolved = yield* resolveProjectScopedInput({
        ...input,
        stateRoot: rigRoot(),
      })
      yield* runLifecycleAction("down", resolved)
    }),
).pipe(Command.withDescription("Stop an existing Rig Target."))

const statusCommand = Command.make(
  "status",
  {
    project: projectFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput({
        ...input,
        stateRoot: rigRoot(),
      })
      const decoded = yield* decodeRigStatusInput(scoped)
      const config = yield* loadProjectConfig({
        project: decoded.project,
        configPath: scoped.configPath,
      })
      const runtime = yield* RigRuntime
      const logger = yield* RigLogger
      const rigd = yield* Rigd
      const state = yield* runtime.describeFoundation(decoded)

      const foundationStatus = { ...state, lane: scoped.lane }
      yield* logger.info(formatFoundationStatus(foundationStatus))
      const health = yield* rigd.health({
        stateRoot: decoded.stateRoot,
      })
      const inventory = yield* rigd.inventory({
        project: decoded.project,
        stateRoot: decoded.stateRoot,
        ...(config ? { config } : {}),
      })
      yield* logger.info(formatRigdStatus({
        status: health.status,
        project: inventory.project,
        deploymentCount: inventory.deployments.length,
      }))
      yield* runLifecycleAction("status", {
        ...scoped,
        ...(config ? { config } : {}),
      })
    }),
).pipe(
  Command.withDescription("Inspect the isolated rig runtime foundation."),
)

const initCommand = Command.make(
  "init",
  {
    project: projectFlag,
    path: initPathFlag,
    domain: initDomainFlag,
    proxy: initProxyFlag,
    uses: usesFlag,
    managed: initManagedFlag,
    managedCommand: initManagedCommandFlag,
    managedPort: initManagedPortFlag,
    managedHealth: initManagedHealthFlag,
    installed: initInstalledFlag,
    installedEntrypoint: initInstalledEntrypointFlag,
    installedBuild: initInstalledBuildFlag,
    installedName: initInstalledNameFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const project = input.project.trim()
      const initializer = yield* RigProjectInitializer
      const logger = yield* RigLogger
      const componentPlugins = yield* parseInitUses(input.uses)
      const managedComponent = yield* parseInitManagedComponent(input)
      const installedComponent = yield* parseInitInstalledComponent(input)
      if (managedComponent && installedComponent && managedComponent.name === installedComponent.name) {
        return yield* Effect.fail(
          new RigCliArgumentError(
            `Cannot scaffold duplicate component '${managedComponent.name}'.`,
            "Use distinct names for --managed and --installed.",
            { component: managedComponent.name },
          ),
        )
      }
      const domain = input.domain.trim()
      const proxy = input.proxy.trim()
      const result = yield* initializer.init({
        project,
        path: input.path,
        stateRoot: rigRoot(),
        providerProfile: initProviderProfile(),
        ...(domain ? { domain } : {}),
        ...(proxy ? { proxy } : {}),
        packageScripts: false,
        componentPlugins,
        ...(managedComponent ? { managedComponent } : {}),
        ...(installedComponent ? { installedComponent } : {}),
      })
      yield* logger.info("rig project initialized", result)
    }),
).pipe(Command.withDescription("Initialize a rig.json without touching v1 state."))

const listCommand = Command.make(
  "list",
  {},
  () =>
    Effect.gen(function* () {
      const logger = yield* RigLogger
      const rigd = yield* Rigd
      const model = yield* rigd.webReadModel({ stateRoot: rigRoot() })

      yield* logger.info(formatProjectList(model))
    }),
).pipe(Command.withDescription("List rig projects and deployments from rigd state."))

const makeDeployCommand = (
  name: "live" | "preview",
  target: RigDeployTarget,
  defaultBranch: string,
  description: string,
) => Command.make(
  name,
  {
    project: projectFlag,
    branch: Argument.string("branch").pipe(Argument.withDefault(defaultBranch)),
    deployment: Flag.string("deployment").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Optional Preview name override."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput({
        project: input.project,
        stateRoot: rigRoot(),
      })
      const decoded = yield* decodeRigStatusInput(scoped)
      const config = yield* requireProjectConfig({
        project: decoded.project,
        configPath: scoped.configPath,
        command: "deploy",
      })
      const intents = yield* RigDeployIntents
      const logger = yield* RigLogger
      const rigd = yield* Rigd
      const intent = yield* intents.fromCliDeploy({
        project: decoded.project,
        stateRoot: decoded.stateRoot,
        ref: input.branch,
        target,
        config,
        ...(input.deployment.trim().length > 0 ? { deploymentName: input.deployment.trim() } : {}),
      })

      yield* logger.info("rig deploy intent", intent)
      const receipt = yield* rigd.deploy({
        project: decoded.project,
        stateRoot: decoded.stateRoot,
        ref: input.branch,
        target,
        config,
        ...(input.deployment.trim().length > 0 ? { deploymentName: input.deployment.trim() } : {}),
      })
      yield* logger.info("rig deploy accepted", receipt)
    }),
).pipe(Command.withDescription(description))

const deployCommand = Command.make("deploy").pipe(
  Command.withDescription("Deploy a Branch to a Stable Target or Preview."),
  Command.withSubcommands([
    makeDeployCommand("live", "live", "main", "Deploy the Production Branch to the Stable Target."),
    makeDeployCommand("preview", "generated", "HEAD", "Deploy a Branch as a Preview."),
  ]),
)

const caddyDoctorChecks = (input: {
  readonly project: string
  readonly providerProfile: string
  readonly providerIds: readonly string[]
  readonly homeConfig: RigHomeConfig
  readonly config?: RigProjectConfig
}) => {
  if (!input.providerIds.includes("caddy")) {
    return []
  }

  const reload = input.homeConfig.providers.caddy.reload
  if (reload.mode !== "command" || reload.command?.trim()) {
    return []
  }

  const component = input.config?.live?.proxy?.upstream
  const caddyfile = input.homeConfig.providers.caddy.caddyfile

  return [{
    name: "caddy",
    providerId: "caddy",
    ok: false,
    profile: input.providerProfile,
    project: input.project,
    deployment: "live",
    ...(component ? { component } : {}),
    reason: "caddy-reload-command-missing",
    message: "Caddy reload is configured for command mode but no command is set.",
    hint: "Set providers.caddy.reload.command in rig home config or switch providers.caddy.reload.mode to manual.",
    details: {
      family: "proxy-router",
      reloadMode: reload.mode,
      ...(caddyfile ? { caddyfile } : {}),
    },
  }]
}

const doctorCommand = Command.make(
  "doctor",
  {
    project: projectFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput({
        project: input.project,
        stateRoot: rigRoot(),
      })
      const decoded = yield* decodeRigStatusInput(scoped)
      const config = yield* loadProjectConfig({
        project: decoded.project,
        configPath: scoped.configPath,
      })
      const doctor = yield* RigDoctor
      const logger = yield* RigLogger
      const providerRegistry = yield* RigProviderRegistry
      const homeConfigStore = yield* RigHomeConfigStore
      const providerReport = yield* providerRegistry.current
      const homeConfig = yield* homeConfigStore.read({ stateRoot: decoded.stateRoot })
      const providerIds = providerReport.providers.map((provider) => provider.id)
      const report = yield* doctor.report({
        project: decoded.project,
        path: { ok: true, entries: [decoded.stateRoot] },
        binaries: [],
        health: [],
        ports: [],
        staleState: [],
        providers: [
          ...providerReport.providers.map((provider) => ({
            name: provider.id,
            providerId: provider.id,
            ok: true,
            profile: providerReport.profile,
            details: {
              displayName: provider.displayName,
              family: provider.family,
              source: provider.source,
              capabilities: provider.capabilities,
              ...(provider.packageName ? { packageName: provider.packageName } : {}),
            },
          })),
          ...caddyDoctorChecks({
            project: decoded.project,
            providerProfile: providerReport.profile,
            providerIds,
            homeConfig,
            ...(config ? { config } : {}),
          }),
        ],
      })

      yield* logger.info("rig doctor report", report)
    }),
).pipe(Command.withDescription("Report rig PATH, binary, health, port, stale-state, and provider checks."))

const configReadCommand = Command.make(
  "read",
  {
    project: projectFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput({
        project: input.project,
        stateRoot: rigRoot(),
      })
      const configPath = yield* requireConfigPath(scoped)
      const decoded = yield* decodeRigStatusInput(scoped)
      const rigd = yield* Rigd
      const logger = yield* RigLogger
      const model = yield* rigd.configRead({
        project: decoded.project,
        configPath,
      })

      yield* logger.info("rig config read", {
        ...model,
        fieldCount: model.fields.length,
      })
    }),
).pipe(Command.withDescription("Read editor-ready rig project config, revision, and field docs."))

const configCommand = Command.make("config").pipe(
  Command.withDescription("Read Rig project config through rigd."),
  Command.withSubcommands([
    configReadCommand,
  ]),
)

const rigCommand = Command.make("rig").pipe(
  Command.withDescription("Local Mac deployment manager."),
  Command.withSubcommands([
    initCommand,
    lifecycleCommand("up", "Start an existing Rig Target."),
    lifecycleCommand("restart", "Restart an existing Rig Target."),
    downCommand,
    logsCommand,
    statusCommand,
    listCommand,
    deployCommand,
    doctorCommand,
    configCommand,
  ]),
)

export const runRigCli = (argv: readonly string[]) =>
  Command.runWith(rigCommand, { version: "0.0.0-rig" })(argv).pipe(
    Effect.as(0),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const logger = yield* RigLogger
        yield* logger.error(unknownToRigCliError(error))
        return 1
      }),
    ),
    Effect.provide(cliEnvironmentLayer),
  )
