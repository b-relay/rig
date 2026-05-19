import { Effect, FileSystem, Layer, Path, Sink, Stdio, Stream, Terminal } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { BunStdio } from "@effect/platform-bun"

import { decodeRigStatusInput, type RigProjectConfig } from "./config.js"
import { RigdDaemonAdmin } from "./daemon-admin.js"
import { RigDeployIntents, type RigDeployTarget } from "./deploy-intent.js"
import type { RigDeploymentRecord } from "./deployments.js"
import { RigDoctor } from "./doctor.js"
import { RigCliArgumentError, unknownToRigCliError, type RigRuntimeError } from "./errors.js"
import { RigGitWorkspace, type RigGitUpstreamStatus } from "./git-workspace.js"
import { RigHomeConfigStore, type RigHomeConfig } from "./home-config.js"
import { RigLifecycle, type RigLifecycleAction, type RigLifecycleLane, type RigLifecycleTarget } from "./lifecycle.js"
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
import { Rigd, type RigdWebProjectRow, type RigdWebReadModel } from "./rigd.js"
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
  readonly repoPath?: string
}

type CliLifecycleAction = "up" | "down" | "restart" | "logs"

interface LifecycleTargetSelection {
  readonly target: RigLifecycleTarget
  readonly lane?: RigLifecycleLane
}

const formatFoundationStatus = (state: RigFoundationState & { readonly lane: RigLifecycleLane }) => [
  "rig foundation ready",
  `project: ${state.project}`,
  `lane: ${state.lane}`,
  `state root: ${state.stateRoot}`,
  `namespace: ${state.namespace}`,
  `launchd label prefix: ${state.launchdLabelPrefix}`,
].join("\n")

const targetCountForProject = (model: RigdWebReadModel, project: RigdWebProjectRow): number =>
  project.targetCount ?? model.deployments.filter((deployment) => deployment.project === project.name).length

const formatProjectList = (model: RigdWebReadModel) => {
  const projectLines = model.projects.length === 0
    ? ["projects: none"]
    : [
      "projects:",
      ...model.projects.map((project) => `  ${project.name} targets=${targetCountForProject(model, project)}`),
    ]

  return [
    "rig projects",
    `rigd: ${model.health.rigd.status}`,
    ...projectLines,
  ].join("\n")
}

const projectRegistration = (
  model: RigdWebReadModel,
  project: string,
): RigdWebProjectRow | undefined =>
  model.projects.find((candidate) => candidate.name === project)

const requireRegisteredProject = (
  model: RigdWebReadModel,
  project: string,
): Effect.Effect<RigdWebProjectRow, RigCliArgumentError> => {
  const registration = projectRegistration(model, project)
  if (registration) {
    return Effect.succeed(registration)
  }

  return Effect.fail(
    new RigCliArgumentError(
      `Project '${project}' is not registered with rigd.`,
      "Run 'rig init' from the project repo, or pass --project with a Project known to rigd.",
      { project, knownProjects: model.projects.map((candidate) => candidate.name) },
    ),
  )
}

const formatPorts = (deployment: RigDeploymentRecord): string => {
  const entries = Object.entries(deployment.assignedPorts)
  return entries.length === 0
    ? "none"
    : entries.map(([component, port]) => `${component}:${port}`).join(",")
}

const formatDeploymentRef = (deployment: RigDeploymentRecord): string =>
  deployment.sourceRef ?? (deployment.kind === "local" ? "working-copy" : "unknown")

const formatProjectStatus = (input: {
  readonly status: string
  readonly project: string
  readonly deployments: readonly RigDeploymentRecord[]
}) => {
  const targetLines = input.deployments.length === 0
    ? ["targets: none"]
    : [
      "targets:",
      ...input.deployments.map((deployment) =>
        `  ${deployment.name} (${deployment.kind}) profile=${deployment.providerProfile} ports=${formatPorts(deployment)} ref=${formatDeploymentRef(deployment)}`
      ),
    ]

  return [
    "rig project status",
    `rigd: ${input.status}`,
    `project: ${input.project}`,
    ...targetLines,
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
      repoPath: located.repoPath,
    }
  })

const inferCurrentProjectOptional = (): Effect.Effect<
  | { readonly name: string; readonly repoPath: string; readonly configPath: string }
  | undefined,
  never,
  RigProjectLocator
> =>
  Effect.gen(function* () {
    const locator = yield* RigProjectLocator
    return yield* locator.inferCurrentProject.pipe(
      Effect.match({
        onSuccess: (located) => located,
        onFailure: () => undefined,
      }),
    )
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
    readonly target?: RigLifecycleTarget
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
      ...(input.lane ? { lane: input.lane } : {}),
      ...(input.target ? { target: input.target } : {}),
      stateRoot: decoded.stateRoot,
      ...(config ? { config } : {}),
      ...(input.follow !== undefined ? { follow: input.follow } : {}),
      ...(input.lines !== undefined ? { lines: input.lines } : {}),
      ...(input.structured !== undefined ? { structured: input.structured } : {}),
    })
  })

const targetGuidance = (command: string) =>
  new RigCliArgumentError(
    `rig ${command} requires a Target in non-interactive use.`,
    "Pass 'local', 'live', or 'preview <branch>'.",
    { command, allowedTargets: ["local", "live", "preview <branch>"] },
  )

const parseLifecycleTarget = (input: {
  readonly action: CliLifecycleAction
  readonly rawTarget: string
  readonly rawPreviewBranch: string
}): Effect.Effect<LifecycleTargetSelection, RigCliArgumentError> => {
  const target = input.rawTarget.trim()
  const previewBranch = input.rawPreviewBranch.trim()
  if (!target) {
    return Effect.fail(targetGuidance(input.action))
  }
  if (target === "local" || target === "live") {
    if (previewBranch) {
      return Effect.fail(
        new RigCliArgumentError(
          `rig ${input.action} ${target} does not accept a Preview Branch.`,
          "Use 'preview <branch>' when targeting a Preview.",
          { command: input.action, target, previewBranch },
        ),
      )
    }
    return Effect.succeed({ lane: target, target: { kind: target } })
  }
  if (target === "preview") {
    if (!previewBranch) {
      return Effect.fail(
        new RigCliArgumentError(
          `rig ${input.action} preview requires a Branch.`,
          "Pass the Preview Branch, for example 'preview feature/login'.",
          { command: input.action, target },
        ),
      )
    }
    return Effect.succeed({ target: { kind: "generated", deploymentName: previewBranch } })
  }
  return Effect.fail(
    new RigCliArgumentError(
      `Unknown Target '${target}'.`,
      "Use 'local', 'live', or 'preview <branch>'.",
      { command: input.action, target },
    ),
  )
}

const lifecycleCommand = (action: CliLifecycleAction, description: string) =>
  Command.make(
    action,
    {
      project: projectFlag,
      target: Argument.string("target").pipe(Argument.withDefault("")),
      previewBranch: Argument.string("branch").pipe(Argument.withDefault("")),
    },
    (input) =>
      Effect.gen(function* () {
        const target = yield* parseLifecycleTarget({
          action,
          rawTarget: input.target,
          rawPreviewBranch: input.previewBranch,
        })
        const resolved = yield* resolveProjectScopedInput({
          ...input,
          stateRoot: rigRoot(),
        })
        yield* runLifecycleAction(action, {
          project: resolved.project,
          stateRoot: resolved.stateRoot,
          ...(target.lane ? { lane: target.lane } : {}),
          target: target.target,
          ...(resolved.configPath ? { configPath: resolved.configPath } : {}),
        })
      }),
  ).pipe(Command.withDescription(description))

const logsCommand = Command.make(
  "logs",
  {
    project: projectFlag,
    target: Argument.string("target").pipe(Argument.withDefault("")),
    previewBranch: Argument.string("branch").pipe(Argument.withDefault("")),
    follow: Flag.boolean("follow").pipe(Flag.withDescription("Follow log output.")),
    lines: Flag.integer("lines").pipe(
      Flag.withDefault(50),
      Flag.withDescription("Number of log lines to read."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const target = yield* parseLifecycleTarget({
        action: "logs",
        rawTarget: input.target,
        rawPreviewBranch: input.previewBranch,
      })
      const resolved = yield* resolveProjectScopedInput({
        ...input,
        stateRoot: rigRoot(),
      })
      yield* runLifecycleAction("logs", {
        project: resolved.project,
        stateRoot: resolved.stateRoot,
        ...(target.lane ? { lane: target.lane } : {}),
        target: target.target,
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
    target: Argument.string("target").pipe(Argument.withDefault("")),
    previewBranch: Argument.string("branch").pipe(Argument.withDefault("")),
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

      const target = yield* parseLifecycleTarget({
        action: "down",
        rawTarget: input.target,
        rawPreviewBranch: input.previewBranch,
      })
      const resolved = yield* resolveProjectScopedInput({
        ...input,
        stateRoot: rigRoot(),
      })
      yield* runLifecycleAction("down", {
        project: resolved.project,
        stateRoot: resolved.stateRoot,
        ...(target.lane ? { lane: target.lane } : {}),
        target: target.target,
        ...(resolved.configPath ? { configPath: resolved.configPath } : {}),
      })
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
      const model = yield* rigd.webReadModel({ stateRoot: decoded.stateRoot })
      yield* requireRegisteredProject(model, decoded.project)
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
      yield* logger.info(formatProjectStatus({
        status: health.status,
        project: inventory.project,
        deployments: inventory.deployments,
      }))
      yield* runLifecycleAction("status", {
        ...scoped,
        ...(config ? { config } : {}),
      })
    }),
).pipe(
  Command.withDescription("Inspect all Targets for one registered Project."),
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
).pipe(Command.withDescription("List Host Project summaries from rigd state."))

const requireRepoPath = (input: ProjectScopedInput, command: string): Effect.Effect<string, RigCliArgumentError> => {
  if (input.repoPath) {
    return Effect.succeed(input.repoPath)
  }
  return Effect.fail(
    new RigCliArgumentError(
      `rig ${command} requires a managed Git repo.`,
      "Run the command from the project repo so Rig can resolve local Branches and Commits.",
      { project: input.project, command },
    ),
  )
}

const productionBranchForDeploy = (
  config: RigProjectConfig,
  stateRoot: string,
): Effect.Effect<string, never, RigHomeConfigStore> =>
  Effect.gen(function* () {
    if (config.live?.deployBranch) {
      return config.live.deployBranch
    }
    const homeConfigStore = yield* RigHomeConfigStore
    const homeConfig = yield* homeConfigStore.read({ stateRoot }).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    return homeConfig?.deploy.productionBranch ?? "main"
  })

const resolveDeployBranch = (input: {
  readonly command: "live" | "preview"
  readonly rawBranch: string
  readonly productionBranch: string
  readonly repoPath: string
}): Effect.Effect<string, RigCliArgumentError | RigRuntimeError, RigGitWorkspace> =>
  Effect.gen(function* () {
    const branch = input.rawBranch.trim()
    if (input.command === "live") {
      const selected = branch || input.productionBranch
      if (selected !== input.productionBranch) {
        return yield* Effect.fail(
          new RigCliArgumentError(
            `Cannot deploy Branch '${selected}' to the Stable Target.`,
            `Deploy the configured Production Branch '${input.productionBranch}' with 'rig deploy live'.`,
            {
              branch: selected,
              productionBranch: input.productionBranch,
              reason: "non-production-live-deploy",
            },
          ),
        )
      }
      return selected
    }

    const git = yield* RigGitWorkspace
    const selected = branch || (yield* git.currentBranch(input.repoPath))
    if (selected === input.productionBranch) {
      return yield* Effect.fail(
        new RigCliArgumentError(
          `Cannot deploy Production Branch '${input.productionBranch}' as a Preview.`,
          `Create a Preview Branch such as 'preview/${input.productionBranch}' and deploy that Branch instead.`,
          {
            branch: selected,
            productionBranch: input.productionBranch,
            reason: "production-branch-preview",
          },
        ),
      )
    }
    return selected
  })

const requireLocalBranch = (input: {
  readonly repoPath: string
  readonly branch: string
}): Effect.Effect<void, RigCliArgumentError | RigRuntimeError, RigGitWorkspace> =>
  Effect.gen(function* () {
    const git = yield* RigGitWorkspace
    const exists = yield* git.branchExists(input.repoPath, input.branch)
    if (exists) {
      return
    }
    return yield* Effect.fail(
      new RigCliArgumentError(
        `Branch '${input.branch}' does not exist locally.`,
        "Create or check out the Branch locally before deploying it.",
        { branch: input.branch, repoPath: input.repoPath, reason: "local-branch-missing" },
      ),
    )
  })

const upstreamWarningDetails = (
  branch: string,
  status: RigGitUpstreamStatus,
): Readonly<Record<string, unknown>> | undefined =>
  status.ahead > 0 || status.behind > 0
    ? {
      branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      message: `Branch '${branch}' differs from upstream ${status.upstream ?? "(none)"}: ahead=${status.ahead} behind=${status.behind}.`,
    }
    : undefined

const makeDeployCommand = (
  name: "live" | "preview",
  target: RigDeployTarget,
  description: string,
) => Command.make(
  name,
  {
    project: projectFlag,
    branch: Argument.string("branch").pipe(Argument.withDefault("")),
    force: Flag.boolean("force").pipe(Flag.withDescription("Redeploy even when the selected Branch resolves to the same Commit.")),
    noUp: Flag.boolean("no-up").pipe(Flag.withDescription("Materialize the selected Commit without starting the Target.")),
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
      const git = yield* RigGitWorkspace
      const repoPath = yield* requireRepoPath(scoped, "deploy")
      const productionBranch = yield* productionBranchForDeploy(config, decoded.stateRoot)
      const branch = yield* resolveDeployBranch({
        command: name,
        rawBranch: input.branch,
        productionBranch,
        repoPath,
      })
      yield* requireLocalBranch({ repoPath, branch })
      const commit = yield* git.branchCommit(repoPath, branch)
      const upstreamStatus = yield* git.upstreamStatus(repoPath, branch)
      const warning = upstreamWarningDetails(branch, upstreamStatus)
      if (warning) {
        yield* logger.info("rig deploy git warning", warning)
      }
      const intent = yield* intents.fromCliDeploy({
        project: decoded.project,
        stateRoot: decoded.stateRoot,
        ref: branch,
        commit,
        target,
        config,
        ...(input.deployment.trim().length > 0 ? { deploymentName: input.deployment.trim() } : {}),
      })

      yield* logger.info("rig deploy intent", intent)
      const receipt = yield* rigd.deploy({
        project: decoded.project,
        stateRoot: decoded.stateRoot,
        ref: branch,
        commit,
        target,
        force: input.force,
        noUp: input.noUp,
        config,
        ...(input.deployment.trim().length > 0 ? { deploymentName: input.deployment.trim() } : {}),
      })
      yield* logger.info("rig deploy accepted", receipt)
    }),
).pipe(Command.withDescription(description))

const deployCommand = Command.make("deploy").pipe(
  Command.withDescription("Deploy a Branch to a Stable Target or Preview."),
  Command.withSubcommands([
    makeDeployCommand("live", "live", "Deploy the Production Branch to the Stable Target."),
    makeDeployCommand("preview", "generated", "Deploy a Branch as a Preview."),
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
      const stateRoot = rigRoot()
      const explicitProject = input.project.trim()
      const located = yield* inferCurrentProjectOptional()
      const project = explicitProject || located?.name || "host"
      const configPath = located && located.name === project ? located.configPath : undefined
      const decoded = yield* decodeRigStatusInput({ project, stateRoot })
      const configLoad = yield* loadProjectConfig({
        project: decoded.project,
        configPath,
      }).pipe(Effect.match({
        onSuccess: (config) => ({ ok: true as const, config }),
        onFailure: (error) => ({ ok: false as const, error }),
      }))
      const config = configLoad.ok ? configLoad.config : undefined
      const projectConfigChecks = configLoad.ok
        ? []
        : [{
          name: "project-config",
          providerId: "rigd",
          ok: false,
          project: decoded.project,
          reason: "project-config-invalid",
          message: `Unable to load rig config for Project '${decoded.project}'.`,
          hint: configLoad.error.hint,
          details: {
            configPath,
            cause: configLoad.error.message,
          },
        }]
      const doctor = yield* RigDoctor
      const logger = yield* RigLogger
      const rigd = yield* Rigd
      const daemonAdmin = yield* RigdDaemonAdmin
      const providerRegistry = yield* RigProviderRegistry
      const homeConfigStore = yield* RigHomeConfigStore
      const providerReport = yield* providerRegistry.current
      const homeConfig = yield* homeConfigStore.read({ stateRoot: decoded.stateRoot })
      const providerIds = providerReport.providers.map((provider) => provider.id)
      const daemonStatus = yield* daemonAdmin.status({ stateRoot: decoded.stateRoot }).pipe(
        Effect.match({
          onSuccess: (status) => ({ ok: true as const, status }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      )
      const readModel = yield* rigd.webReadModel({ stateRoot: decoded.stateRoot }).pipe(
        Effect.match({
          onSuccess: (model) => ({ ok: true as const, model }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      )
      const registeredProject = readModel.ok
        ? projectRegistration(readModel.model, decoded.project)
        : undefined
      const localhostControlPlane = providerReport.providers.some((provider) =>
        provider.capabilities.includes("127.0.0.1-bind")
      )
      const projectChecks = decoded.project === "host"
        ? []
        : [
          ...projectConfigChecks,
          {
            name: "project-registration",
            providerId: "rigd",
            ok: Boolean(registeredProject),
            profile: providerReport.profile,
            project: decoded.project,
            reason: "project-not-registered",
            message: `Project '${decoded.project}' is not registered with rigd.`,
            hint: "Run 'rig init' from the project repo so rigd can register the Project identity.",
            details: {
              knownProjects: readModel.ok ? readModel.model.projects.map((candidate) => candidate.name) : [],
            },
          },
          ...(located && located.name !== decoded.project
            ? [{
              name: "project-identity",
              providerId: "rigd",
              ok: false,
              profile: providerReport.profile,
              project: decoded.project,
              reason: "project-identity-drift",
              message: `Current rig.json is Project '${located.name}', not '${decoded.project}'.`,
              hint: "Run doctor without --project from this repo, or switch to the matching Project repo.",
              details: {
                requestedProject: decoded.project,
                currentProject: located.name,
                configPath: located.configPath,
              },
            }]
            : []),
          ...(located && registeredProject?.repoPath && registeredProject.repoPath !== located.repoPath
            ? [{
              name: "project-path",
              providerId: "rigd",
              ok: false,
              profile: providerReport.profile,
              project: decoded.project,
              reason: "project-path-drift",
              message: `Project '${decoded.project}' is registered to a different repo path.`,
              hint: "Rerun 'rig init' from the intended repo or repair the stale rigd registration.",
              details: {
                registeredPath: registeredProject.repoPath,
                currentPath: located.repoPath,
              },
            }]
            : []),
          ...(registeredProject?.duplicateIdentityPaths?.length
            ? [{
              name: "project-identity",
              providerId: "rigd",
              ok: false,
              profile: providerReport.profile,
              project: decoded.project,
              reason: "duplicate-project-identity",
              message: `Project '${decoded.project}' has multiple registered repo paths.`,
              hint: "Repair rigd project registration before relying on Project-scoped commands.",
              details: {
                paths: registeredProject.duplicateIdentityPaths,
              },
            }]
            : []),
          ...(registeredProject?.duplicatePathProjects?.length
            ? [{
              name: "project-path",
              providerId: "rigd",
              ok: false,
              profile: providerReport.profile,
              project: decoded.project,
              reason: "duplicate-project-path",
              message: `Project '${decoded.project}' shares its repo path with another Project.`,
              hint: "Repair rigd project registration so one repo path maps to one Project identity.",
              details: {
                projects: registeredProject.duplicatePathProjects,
              },
            }]
            : []),
        ]
      const report = yield* doctor.report({
        project: decoded.project,
        path: { ok: true, entries: [decoded.stateRoot, ...(configPath ? [configPath] : [])] },
        binaries: [],
        health: [],
        ports: [],
        staleState: [],
        providers: [
          {
            name: "rigd-daemon",
            providerId: "rigd",
            ok: daemonStatus.ok && daemonStatus.status.reachable,
            profile: providerReport.profile,
            reason: "rigd-unreachable",
            message: "rigd is not reachable from the normal rig CLI.",
            hint: "Run 'rigd install' to set up the daemon, or 'rigd status' to inspect it.",
            details: daemonStatus.ok
              ? {
                installed: daemonStatus.status.installed,
                running: daemonStatus.status.running,
                reachable: daemonStatus.status.reachable,
                tokenPresent: daemonStatus.status.tokenPresent,
                daemonStatePath: daemonStatus.status.daemonStatePath,
              }
              : {
                cause: daemonStatus.error.message,
              },
          },
          {
            name: "host-capability",
            providerId: "localhost-http",
            ok: localhostControlPlane,
            profile: providerReport.profile,
            reason: "host-capability-missing",
            message: "Host control-plane provider is missing localhost binding support.",
            hint: "Use a provider profile that includes the localhost-http control-plane transport.",
            details: {
              requiredCapability: "127.0.0.1-bind",
              providers: providerReport.providers.map((provider) => provider.id),
            },
          },
          ...projectChecks,
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
).pipe(Command.withDescription("Report Host diagnostics and Project diagnostics when context exists."))

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
