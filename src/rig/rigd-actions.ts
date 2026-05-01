import { Context, Effect, Layer } from "effect"

import type { RigProjectConfig, RigRuntimePlanComponent } from "./config.js"
import type { RigDeploymentManagerService, RigDeploymentRecord } from "./deployments.js"
import { evaluateRigPreflight, type RigDoctorCheckInput, type RigDoctorFailure } from "./doctor.js"
import { RigRuntimeError } from "./errors.js"
import type { RigProviderRegistryService } from "./provider-contracts.js"
import type { RigdStateStoreService } from "./rigd-state.js"

export type RigdActionKind = "lifecycle" | "deploy" | "destroy"

export interface RigdActionPreflightInput {
  readonly kind: RigdActionKind
  readonly project: string
  readonly stateRoot: string
  readonly target: string
  readonly ref?: string
  readonly deploymentName?: string
  readonly config?: RigProjectConfig
}

export interface RigdActionPreflightService {
  readonly verify: (input: RigdActionPreflightInput) => Effect.Effect<void, RigRuntimeError>
}

export interface RigdActionPreflightDependencies {
  readonly deployments: RigDeploymentManagerService
  readonly stateStore: RigdStateStoreService
  readonly providerRegistry: RigProviderRegistryService
}

export const RigdActionPreflight =
  Context.Service<RigdActionPreflightService>("rig/rig/RigdActionPreflight")

const targetDeploymentKind = (target: string): RigDeploymentRecord["kind"] | undefined =>
  target === "local" || target === "live"
    ? target
    : target.startsWith("generated:")
      ? "generated"
      : undefined

const targetDeploymentName = (target: string): string =>
  target.startsWith("generated:") ? target.replace(/^generated:/, "") : target

const hookChecks = (
  scope: string,
  hooks: { readonly preStart?: string; readonly postStart?: string; readonly preStop?: string; readonly postStop?: string } | undefined,
) =>
  Object.entries(hooks ?? {}).map(([name, command]) => ({
    name: `${scope}.${name}`,
    ok: command.trim().length > 0,
    details: { command },
  }))

const componentNames = (components: readonly RigRuntimePlanComponent[]): ReadonlySet<string> =>
  new Set(components.map((component) => component.name))

const dependencyChecks = (components: readonly RigRuntimePlanComponent[]) => {
  const names = componentNames(components)
  return components.flatMap((component) =>
    component.kind === "managed"
      ? (component.dependsOn ?? []).map((dependency) => ({
        name: `${component.name}->${dependency}`,
        ok: names.has(dependency),
        details: {
          component: component.name,
          dependency,
        },
      }))
      : [],
  )
}

const proxyChecks = (deployment: RigDeploymentRecord | undefined) => {
  const upstream = deployment?.resolved.runtimePlan.proxy?.upstream
  if (!upstream) {
    return []
  }
  const upstreamComponent = deployment?.resolved.runtimePlan.components.find((component) => component.name === upstream)
  return [{
    name: `proxy:${upstream}`,
    ok: upstreamComponent?.kind === "managed",
    details: {
      upstream,
      ...(upstreamComponent ? { kind: upstreamComponent.kind } : { reason: "missing-upstream" }),
    },
  }]
}

const binaryChecks = (components: readonly RigRuntimePlanComponent[]) =>
  components.flatMap((component) =>
    component.kind === "installed"
      ? [
        {
          path: component.entrypoint,
          ok: component.entrypoint.trim().length > 0,
          details: {
            component: component.name,
            role: "entrypoint",
          },
        },
        ...(component.build
          ? [{
            path: component.build,
            ok: component.build.trim().length > 0,
            details: {
              component: component.name,
              role: "build",
            },
          }]
          : []),
      ]
      : [],
  )

const envChecks = (
  deployment: RigDeploymentRecord | undefined,
  components: readonly RigRuntimePlanComponent[],
) => [
  ...(deployment?.resolved.runtimePlan.envFile
    ? [{
      name: "lane.envFile",
      ok: deployment.resolved.runtimePlan.envFile.trim().length > 0,
      details: { envFile: deployment.resolved.runtimePlan.envFile },
    }]
    : []),
  ...components.flatMap((component) =>
    component.envFile
      ? [{
        name: `${component.name}.envFile`,
        ok: component.envFile.trim().length > 0,
        details: {
          component: component.name,
          envFile: component.envFile,
        },
      }]
      : [],
  ),
]

const healthChecks = (components: readonly RigRuntimePlanComponent[]) =>
  components.flatMap((component) =>
    component.kind === "managed" && component.health
      ? [{
        component: component.name,
        target: component.health,
        ok: true,
        ownedByRig: true,
      }]
      : [],
  )

const portChecks = (
  deployment: RigDeploymentRecord | undefined,
  components: readonly RigRuntimePlanComponent[],
  reservations: readonly {
    readonly project: string
    readonly deployment: string
    readonly component: string
    readonly port: number
    readonly status: "reserved" | "stale"
  }[],
) =>
  components.flatMap((runtimeComponent) =>
    runtimeComponent.kind === "managed"
      ? [{ component: runtimeComponent.name, port: runtimeComponent.port }]
      : [],
  ).map(({ component, port }, _index, requestedPorts) => {
    const duplicate = requestedPorts.find((candidate) =>
      candidate.component !== component && candidate.port === port
    )
    const conflict = reservations.find((reservation) =>
      reservation.status === "reserved" &&
      reservation.port === port &&
      (
        reservation.project !== deployment?.project ||
        reservation.deployment !== deployment?.name ||
        reservation.component !== component
      )
    )
    return {
      component,
      port,
      available: duplicate === undefined && conflict === undefined,
      details: conflict
        ? {
          conflictingProject: conflict.project,
          conflictingDeployment: conflict.deployment,
          conflictingComponent: conflict.component,
        }
        : duplicate
          ? {
            conflictingProject: deployment?.project,
            conflictingDeployment: deployment?.name,
            conflictingComponent: duplicate.component,
            reason: "duplicate-deployment-port",
          }
        : undefined,
    }
  })

const runningPortReservations = (
  state: {
    readonly portReservations: readonly {
      readonly project: string
      readonly deployment: string
      readonly component: string
      readonly port: number
      readonly status: "reserved" | "stale"
    }[]
    readonly desiredDeployments: readonly {
      readonly project: string
      readonly deployment: string
      readonly desiredStatus: "running" | "stopped" | "failed"
    }[]
  },
) => {
  const runningDeployments = new Set(
    state.desiredDeployments
      .filter((desired) => desired.desiredStatus === "running")
      .map((desired) => `${desired.project}:${desired.deployment}`),
  )

  return state.portReservations.filter((reservation) =>
    runningDeployments.has(`${reservation.project}:${reservation.deployment}`)
  )
}

const providerChecks = (
  deployment: RigDeploymentRecord | undefined,
  providers: readonly { readonly id: string; readonly family: string }[],
  profile: string,
) => {
  const processSupervisor = deployment?.resolved.providers.processSupervisor
  if (!processSupervisor) {
    return []
  }
  const found = providers.some((provider) =>
    provider.family === "process-supervisor" && provider.id === processSupervisor
  )
  return [{
    name: `process-supervisor:${processSupervisor}`,
    ok: found,
    profile,
    details: {
      family: "process-supervisor",
      provider: processSupervisor,
    },
  }]
}

const deploymentForPreflight = (
  deployments: RigDeploymentManagerService,
  input: RigdActionPreflightInput,
): Effect.Effect<RigDeploymentRecord | undefined, RigRuntimeError> =>
  Effect.gen(function* () {
    if (!input.config) {
      return undefined
    }
    const kind = targetDeploymentKind(input.target)
    if (!kind) {
      return undefined
    }
    const inventory = yield* deployments.list({
      config: input.config,
      stateRoot: input.stateRoot,
    })
    const name = targetDeploymentName(input.target)
    const found = inventory.find((deployment) => deployment.kind === kind && deployment.name === name)
    if (found || kind !== "generated") {
      return found
    }
    return yield* deployments.previewGenerated({
      config: input.config,
      stateRoot: input.stateRoot,
      branch: input.ref ?? name,
      ...(input.deploymentName ? { name: input.deploymentName } : {}),
    })
  })

export const preflightError = (
  input: RigdActionPreflightInput,
  failures: readonly RigDoctorFailure[],
  checkedCategories: readonly string[],
) =>
  new RigRuntimeError(
    `Preflight failed for ${input.kind} action '${input.target}'.`,
    "Resolve the reported preflight failures before retrying the runtime action.",
    {
      reason: "preflight-failed",
      kind: input.kind,
      project: input.project,
      target: input.target,
      checkedCategories,
      failures,
    },
  )

export const deriveRigdActionPreflightChecks = (
  input: RigdActionPreflightInput,
  dependencies: RigdActionPreflightDependencies,
): Effect.Effect<RigDoctorCheckInput, RigRuntimeError> =>
  Effect.gen(function* () {
    const deployment = yield* deploymentForPreflight(dependencies.deployments, input)
    const state = yield* dependencies.stateStore.load({ stateRoot: input.stateRoot })
    const components = deployment?.resolved.runtimePlan.components ?? []
    const providerReport = deployment
      ? yield* dependencies.providerRegistry.forProfile(deployment.providerProfile)
      : yield* dependencies.providerRegistry.current

    return {
      project: input.project,
      deployment: targetDeploymentName(input.target),
      dependencies: [
        ...dependencyChecks(components),
        ...proxyChecks(deployment),
      ],
      binaries: binaryChecks(components),
      env: envChecks(deployment, components),
      hooks: [
        ...hookChecks("project", deployment?.resolved.runtimePlan.hooks),
        ...components.flatMap((component) => hookChecks(component.name, component.hooks)),
      ],
      healthChecks: healthChecks(components),
      ports: portChecks(deployment, components, runningPortReservations(state)),
      staleState: [
        {
          name: "runtime-journal",
          ok: true,
          details: {
            receipts: state.receipts.length,
            events: state.events.length,
          },
        },
      ],
      providers: providerChecks(deployment, providerReport.providers, providerReport.profile),
    }
  })

export const verifyRigdActionPreflight = (
  input: RigdActionPreflightInput,
  dependencies: RigdActionPreflightDependencies,
): Effect.Effect<void, RigRuntimeError> =>
  Effect.gen(function* () {
    const checks = yield* deriveRigdActionPreflightChecks(input, dependencies)
    const result = evaluateRigPreflight(checks)
    if (!result.ok) {
      return yield* Effect.fail(preflightError(input, result.failures, result.checkedCategories))
    }
  })

export const RigdActionPreflightLive = Layer.succeed(RigdActionPreflight, {
  verify: () => Effect.void,
} satisfies RigdActionPreflightService)
