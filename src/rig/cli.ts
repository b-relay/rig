import { Effect, FileSystem, Layer, Path, Sink, Stdio, Stream, Terminal } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { BunStdio } from "@effect/platform-bun"

import { decodeRigStatusInput, type RigProjectConfig } from "./config.js"
import type { RigConfigPatchOperation } from "./config-editor.js"
import { RigDeployIntents, type RigDeployTarget } from "./deploy-intent.js"
import { RigDoctor } from "./doctor.js"
import { RigCliArgumentError, unknownToRigCliError } from "./errors.js"
import { RigHomeConfigStore, type RigHomeConfig } from "./home-config.js"
import { RigLifecycle, type RigLifecycleAction, type RigLifecycleLane } from "./lifecycle.js"
import { rigRoot } from "./paths.js"
import { RigProjectConfigLoader } from "./project-config-loader.js"
import { RigProjectInitializer, type RigInitComponentPluginId } from "./project-initializer.js"
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

const laneFlag = Flag.choice("lane", ["local", "live"]).pipe(
  Flag.withDefault("local" as const),
  Flag.withDescription("Rig runtime lane: local working copy or live built deployment."),
)

const stateRootFlag = Flag.string("state-root").pipe(
  Flag.withDefault(rigRoot()),
  Flag.withDescription("Isolated rig state root. Defaults to ~/.rig."),
)

const statusJsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit structured status details after the human-readable status output."),
)

const configFlag = Flag.string("config").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Path to a rig.json. Optional inside a managed repo."),
)

const initPathFlag = Flag.string("path").pipe(
  Flag.withDefault("."),
  Flag.withDescription("Project directory where rig should write rig.json."),
)

const providerProfileFlag = Flag.choice("provider-profile", ["default", "stub"]).pipe(
  Flag.withDefault("default" as const),
  Flag.withDescription("Provider profile to scaffold into the local, live, and generated lanes."),
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

const deployRefFlag = Flag.string("ref").pipe(
  Flag.withDefault("HEAD"),
  Flag.withDescription("Git ref to deploy. Semver is optional metadata, not required."),
)

const deployTargetFlag = Flag.choice("target", ["live", "generated"]).pipe(
  Flag.withDefault("live" as RigDeployTarget),
  Flag.withDescription("Deploy target: live or generated."),
)

const configPathFlag = Flag.string("path").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Dot-separated rig config path, for example live.deployBranch."),
)

const configJsonFlag = Flag.string("json").pipe(
  Flag.withDefault(""),
  Flag.withDescription("JSON value for config set, for example '\"main\"', true, 3070, or '{\"upstream\":\"web\"}'."),
)

const resolveProjectScopedInput = (input: {
  readonly project: string
  readonly lane: RigLifecycleLane
  readonly stateRoot: string
  readonly configPath?: string
}): Effect.Effect<ProjectScopedInput, RigCliArgumentError, RigProjectLocator> =>
  Effect.gen(function* () {
    const explicitProject = input.project.trim()
    const explicitConfigPath = input.configPath?.trim()
    if (explicitProject.length > 0) {
      return {
        ...input,
        project: explicitProject,
        ...(explicitConfigPath ? { configPath: explicitConfigPath } : {}),
      }
    }

    const locator = yield* RigProjectLocator
    const located = yield* locator.inferCurrentProject

    return {
      ...input,
      project: located.name,
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

const requireConfigPath = (
  input: ProjectScopedInput,
): Effect.Effect<string, RigCliArgumentError> => {
  if (input.configPath && input.configPath.trim().length > 0) {
    return Effect.succeed(input.configPath.trim())
  }

  return Effect.fail(
    new RigCliArgumentError(
      "rig config commands require a rig.json path.",
      "Run the command from a managed repo or pass --config <path>.",
      { project: input.project },
    ),
  )
}

const parseConfigPatchPath = (path: string): Effect.Effect<readonly [string, ...string[]], RigCliArgumentError> => {
  const segments = path.split(".").map((segment) => segment.trim())
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return Effect.fail(
      new RigCliArgumentError(
        "Config path must contain non-empty dot-separated segments.",
        "Use a path like live.deployBranch or components.web.port.",
        { path },
      ),
    )
  }

  return Effect.succeed(segments as [string, ...string[]])
}

const parseJsonValue = (raw: string): Effect.Effect<unknown, RigCliArgumentError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new RigCliArgumentError(
        "Config set requires a valid JSON value.",
        "Pass strings with JSON quotes, for example --json '\"main\"'.",
        {
          value: raw,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      ),
  })

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

const runConfigPatch = (input: {
  readonly project: string
  readonly configPath?: string
  readonly stateRoot: string
  readonly path: string
  readonly apply: boolean
  readonly patchFor: (path: readonly [string, ...string[]]) => Effect.Effect<RigConfigPatchOperation, RigCliArgumentError>
}) =>
  Effect.gen(function* () {
    const scoped = yield* resolveProjectScopedInput({
      project: input.project,
      lane: "live",
      stateRoot: input.stateRoot,
      configPath: input.configPath,
    })
    const configPath = yield* requireConfigPath(scoped)
    const decoded = yield* decodeRigStatusInput(scoped)
    const path = yield* parseConfigPatchPath(input.path)
    const patch = yield* input.patchFor(path)
    const rigd = yield* Rigd
    const logger = yield* RigLogger
    const current = yield* rigd.configRead({
      project: decoded.project,
      configPath,
    })
    const request = {
      project: decoded.project,
      configPath,
      expectedRevision: current.revision,
      patch: [patch],
    }

    if (input.apply) {
      const result = yield* rigd.configApply(request)
      yield* logger.info("rig config applied", result)
      return
    }

    const preview = yield* rigd.configPreview(request)
    yield* logger.info("rig config preview", preview)
  })

const runLifecycleAction = (
  action: RigLifecycleAction,
  input: {
    readonly project: string
    readonly lane: RigLifecycleLane
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
    const lifecycle = yield* RigLifecycle
    yield* lifecycle.run({
      action,
      project: decoded.project,
      lane: input.lane,
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
      lane: laneFlag,
      stateRoot: stateRootFlag,
      configPath: configFlag,
    },
    (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveProjectScopedInput(input)
        yield* runLifecycleAction(action, resolved)
      }),
  ).pipe(Command.withDescription(description))

const logsCommand = Command.make(
  "logs",
  {
    project: projectFlag,
    lane: laneFlag,
    stateRoot: stateRootFlag,
    configPath: configFlag,
    follow: Flag.boolean("follow").pipe(Flag.withDescription("Follow log output.")),
    lines: Flag.integer("lines").pipe(
      Flag.withDefault(50),
      Flag.withDescription("Number of log lines to read."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const resolved = yield* resolveProjectScopedInput(input)
      yield* runLifecycleAction("logs", {
        ...resolved,
        follow: input.follow,
        lines: input.lines,
      })
    }),
).pipe(Command.withDescription("Inspect logs for a rig local or live lane."))

const downCommand = Command.make(
  "down",
  {
    project: projectFlag,
    lane: laneFlag,
    stateRoot: stateRootFlag,
    configPath: configFlag,
    destroy: Flag.boolean("destroy").pipe(
      Flag.withDescription("Reserved for generated deployment teardown; rejected for local/live lanes."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      if (input.destroy) {
        return yield* Effect.fail(
          new RigCliArgumentError(
            "down --destroy is reserved for generated deployments.",
            "Use plain 'rig down' for local/live lanes until generated deployments are available.",
            { lane: input.lane },
          ),
        )
      }

      const resolved = yield* resolveProjectScopedInput(input)
      yield* runLifecycleAction("down", resolved)
    }),
).pipe(Command.withDescription("Stop a rig local or live lane."))

const statusCommand = Command.make(
  "status",
  {
    project: projectFlag,
    lane: laneFlag,
    stateRoot: stateRootFlag,
    configPath: configFlag,
    json: statusJsonFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput(input)
      const decoded = yield* decodeRigStatusInput(scoped)
      const config = yield* loadProjectConfig({
        project: decoded.project,
        configPath: scoped.configPath,
      })
      const runtime = yield* RigRuntime
      const logger = yield* RigLogger
      const rigd = yield* Rigd
      const state = yield* runtime.describeFoundation(decoded)

      const foundationStatus = {
        ...state,
        lane: scoped.lane,
      }
      yield* logger.info(formatFoundationStatus(foundationStatus))
      if (input.json) {
        yield* logger.info("rig foundation details", foundationStatus)
      }
      const health = yield* rigd.health({
        stateRoot: decoded.stateRoot,
      })
      const inventory = yield* rigd.inventory({
        project: decoded.project,
        stateRoot: decoded.stateRoot,
        ...(config ? { config } : {}),
      })
      const rigdStatus = {
        health,
        inventory: {
          project: inventory.project,
          deploymentCount: inventory.deployments.length,
        },
      }
      yield* logger.info(formatRigdStatus({
        status: health.status,
        project: inventory.project,
        deploymentCount: inventory.deployments.length,
      }))
      if (input.json) {
        yield* logger.info("rigd status details", rigdStatus)
      }
      yield* runLifecycleAction("status", {
        ...scoped,
        ...(config ? { config } : {}),
        structured: input.json,
      })
    }),
).pipe(
  Command.withDescription("Inspect the isolated rig runtime foundation."),
)

const rigdCommand = Command.make(
  "rigd",
  {
    stateRoot: stateRootFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const rigd = yield* Rigd
      yield* rigd.start({
        stateRoot: input.stateRoot,
      })
    }),
).pipe(Command.withDescription("Start the local rigd MVP API and report health."))

const initCommand = Command.make(
  "init",
  {
    project: projectFlag,
    path: initPathFlag,
    stateRoot: stateRootFlag,
    providerProfile: providerProfileFlag,
    domain: initDomainFlag,
    proxy: initProxyFlag,
    packageScripts: Flag.boolean("package-scripts").pipe(
      Flag.withDescription("Add rig package scripts to package.json when it exists."),
    ),
    uses: usesFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const project = input.project.trim()
      if (project.length === 0) {
        return yield* Effect.fail(
          new RigCliArgumentError(
            "rig init requires --project <name>.",
            "Pass a stable project name, for example rig init --project pantry --path .",
          ),
        )
      }

      const decoded = yield* decodeRigStatusInput({
        project,
        stateRoot: input.stateRoot,
      })
      const initializer = yield* RigProjectInitializer
      const logger = yield* RigLogger
      const componentPlugins = yield* parseInitUses(input.uses)
      const domain = input.domain.trim()
      const proxy = input.proxy.trim()
      const result = yield* initializer.init({
        project: decoded.project,
        path: input.path,
        stateRoot: decoded.stateRoot,
        providerProfile: input.providerProfile,
        ...(domain ? { domain } : {}),
        ...(proxy ? { proxy } : {}),
        packageScripts: input.packageScripts,
        componentPlugins,
      })
      yield* logger.info("rig project initialized", result)
    }),
).pipe(Command.withDescription("Initialize a rig.json without touching v1 state."))

const listCommand = Command.make(
  "list",
  {
    stateRoot: stateRootFlag,
    json: statusJsonFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const logger = yield* RigLogger
      const rigd = yield* Rigd
      const model = yield* rigd.webReadModel({ stateRoot: input.stateRoot })

      yield* logger.info(formatProjectList(model))
      if (input.json) {
        yield* logger.info("rig projects details", model)
      }
    }),
).pipe(Command.withDescription("List rig projects and deployments from rigd state."))

const deployCommand = Command.make(
  "deploy",
  {
    project: projectFlag,
    stateRoot: stateRootFlag,
    configPath: configFlag,
    ref: deployRefFlag,
    target: deployTargetFlag,
    deployment: Flag.string("deployment").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Optional generated deployment name override."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput({
        project: input.project,
        lane: "live",
        stateRoot: input.stateRoot,
        configPath: input.configPath,
      })
      const decoded = yield* decodeRigStatusInput(scoped)
      const config = yield* loadProjectConfig({
        project: decoded.project,
        configPath: scoped.configPath,
      })
      const intents = yield* RigDeployIntents
      const logger = yield* RigLogger
      const rigd = yield* Rigd
      const intent = yield* intents.fromCliDeploy({
        project: decoded.project,
        stateRoot: decoded.stateRoot,
        ref: input.ref,
        target: input.target,
        ...(config ? { config } : {}),
        ...(input.deployment.trim().length > 0 ? { deploymentName: input.deployment.trim() } : {}),
      })

      yield* logger.info("rig deploy intent", intent)
      if (config) {
        const receipt = yield* rigd.deploy({
          project: decoded.project,
          stateRoot: decoded.stateRoot,
          ref: input.ref,
          target: input.target,
          config,
          ...(input.deployment.trim().length > 0 ? { deploymentName: input.deployment.trim() } : {}),
        })
        yield* logger.info("rig deploy accepted", receipt)
      }
    }),
).pipe(Command.withDescription("Create a rig deploy intent for a ref and target without requiring semver."))

const bumpCommand = Command.make(
  "bump",
  {
    project: projectFlag,
    stateRoot: stateRootFlag,
    current: Flag.string("current").pipe(
      Flag.withDefault("0.0.0"),
      Flag.withDescription("Current optional version metadata."),
    ),
    bump: Flag.choice("bump", ["patch", "minor", "major"]).pipe(
      Flag.withDefault("patch" as const),
      Flag.withDescription("Semantic version bump to apply when --set is omitted."),
    ),
    set: Flag.string("set").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Explicit optional version metadata to set."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput({
        project: input.project,
        lane: "live",
        stateRoot: input.stateRoot,
      })
      const decoded = yield* decodeRigStatusInput(scoped)
      const intents = yield* RigDeployIntents
      const logger = yield* RigLogger
      const metadata = yield* intents.bump({
        project: decoded.project,
        currentVersion: input.current,
        ...(input.set.trim().length > 0 ? { set: input.set.trim() } : { bump: input.bump }),
      })

      yield* logger.info("rig bump metadata", metadata)
    }),
).pipe(Command.withDescription("Manage optional version metadata and rollback tag anchors."))

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
    stateRoot: stateRootFlag,
    configPath: configFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput({
        project: input.project,
        lane: "live",
        stateRoot: input.stateRoot,
        configPath: input.configPath,
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
    stateRoot: stateRootFlag,
    configPath: configFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput({
        project: input.project,
        lane: "live",
        stateRoot: input.stateRoot,
        configPath: input.configPath,
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

const configSetCommand = Command.make(
  "set",
  {
    project: projectFlag,
    stateRoot: stateRootFlag,
    configPath: configFlag,
    path: configPathFlag,
    json: configJsonFlag,
    apply: Flag.boolean("apply").pipe(
      Flag.withDescription("Apply the config change. Without this flag, only preview the diff."),
    ),
  },
  (input) =>
    runConfigPatch({
      project: input.project,
      stateRoot: input.stateRoot,
      configPath: input.configPath,
      path: input.path,
      apply: input.apply,
      patchFor: (path) =>
        parseJsonValue(input.json).pipe(
          Effect.map((value) => ({
            op: "set" as const,
            path,
            value,
          })),
        ),
    }),
).pipe(Command.withDescription("Preview or apply a structured rig config set operation."))

const configUnsetCommand = Command.make(
  "unset",
  {
    project: projectFlag,
    stateRoot: stateRootFlag,
    configPath: configFlag,
    path: configPathFlag,
    apply: Flag.boolean("apply").pipe(
      Flag.withDescription("Apply the config removal. Without this flag, only preview the diff."),
    ),
  },
  (input) =>
    runConfigPatch({
      project: input.project,
      stateRoot: input.stateRoot,
      configPath: input.configPath,
      path: input.path,
      apply: input.apply,
      patchFor: (path) =>
        Effect.succeed({
          op: "remove" as const,
          path,
        }),
    }),
).pipe(Command.withDescription("Preview or apply a structured rig config remove operation."))

const configCommand = Command.make("config").pipe(
  Command.withDescription("Read, preview, and apply safe rig project config edits through rigd."),
  Command.withSubcommands([
    configReadCommand,
    configSetCommand,
    configUnsetCommand,
  ]),
)

const rigCommand = Command.make("rig").pipe(
  Command.withDescription("Local Mac deployment manager."),
  Command.withSubcommands([
    initCommand,
    lifecycleCommand("up", "Start a rig local or live lane."),
    lifecycleCommand("restart", "Restart a rig local or live lane."),
    downCommand,
    logsCommand,
    statusCommand,
    listCommand,
    rigdCommand,
    deployCommand,
    bumpCommand,
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
