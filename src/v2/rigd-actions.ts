import { Context, Effect, Layer } from "effect"

import type { V2ProjectConfig, V2RuntimePlanComponent } from "./config.js"
import type { V2DeploymentManagerService, V2DeploymentRecord } from "./deployments.js"
import { evaluateV2Preflight, type V2DoctorCheckInput, type V2DoctorFailure } from "./doctor.js"
import { V2RuntimeError } from "./errors.js"
import type { V2ProviderRegistryService } from "./provider-contracts.js"
import type { V2RigdStateStoreService } from "./rigd-state.js"

export type V2RigdActionKind = "lifecycle" | "deploy" | "destroy"

export interface V2RigdActionPreflightInput {
  readonly kind: V2RigdActionKind
  readonly project: string
  readonly stateRoot: string
  readonly target: string
  readonly config?: V2ProjectConfig
}

export interface V2RigdActionPreflightService {
  readonly verify: (input: V2RigdActionPreflightInput) => Effect.Effect<void, V2RuntimeError>
}

export interface V2RigdActionPreflightDependencies {
  readonly deployments: V2DeploymentManagerService
  readonly stateStore: V2RigdStateStoreService
  readonly providerRegistry: V2ProviderRegistryService
}

export const V2RigdActionPreflight =
  Context.Service<V2RigdActionPreflightService>("rig/v2/V2RigdActionPreflight")

const targetDeploymentKind = (target: string): V2DeploymentRecord["kind"] | undefined =>
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

const componentNames = (components: readonly V2RuntimePlanComponent[]): ReadonlySet<string> =>
  new Set(components.map((component) => component.name))

const dependencyChecks = (components: readonly V2RuntimePlanComponent[]) => {
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

const binaryChecks = (components: readonly V2RuntimePlanComponent[]) =>
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
  deployment: V2DeploymentRecord | undefined,
  components: readonly V2RuntimePlanComponent[],
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

const healthChecks = (components: readonly V2RuntimePlanComponent[]) =>
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
  deployment: V2DeploymentRecord | undefined,
  components: readonly V2RuntimePlanComponent[],
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
  ).map(({ component, port }) => {
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
      available: conflict === undefined,
      details: conflict
        ? {
          conflictingProject: conflict.project,
          conflictingDeployment: conflict.deployment,
          conflictingComponent: conflict.component,
        }
        : undefined,
    }
  })

const providerChecks = (
  deployment: V2DeploymentRecord | undefined,
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
  deployments: V2DeploymentManagerService,
  input: V2RigdActionPreflightInput,
): Effect.Effect<V2DeploymentRecord | undefined, V2RuntimeError> =>
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
    return inventory.find((deployment) => deployment.kind === kind && deployment.name === name)
  })

export const preflightError = (
  input: V2RigdActionPreflightInput,
  failures: readonly V2DoctorFailure[],
  checkedCategories: readonly string[],
) =>
  new V2RuntimeError(
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

export const deriveV2RigdActionPreflightChecks = (
  input: V2RigdActionPreflightInput,
  dependencies: V2RigdActionPreflightDependencies,
): Effect.Effect<V2DoctorCheckInput, V2RuntimeError> =>
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
      dependencies: dependencyChecks(components),
      binaries: binaryChecks(components),
      env: envChecks(deployment, components),
      hooks: [
        ...hookChecks("project", deployment?.resolved.runtimePlan.hooks),
        ...components.flatMap((component) => hookChecks(component.name, component.hooks)),
      ],
      healthChecks: healthChecks(components),
          ports: portChecks(deployment, components, state.portReservations),
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

export const verifyV2RigdActionPreflight = (
  input: V2RigdActionPreflightInput,
  dependencies: V2RigdActionPreflightDependencies,
): Effect.Effect<void, V2RuntimeError> =>
  Effect.gen(function* () {
    const checks = yield* deriveV2RigdActionPreflightChecks(input, dependencies)
    const result = evaluateV2Preflight(checks)
    if (!result.ok) {
      return yield* Effect.fail(preflightError(input, result.failures, result.checkedCategories))
    }
  })

export const V2RigdActionPreflightLive = Layer.succeed(V2RigdActionPreflight, {
  verify: () => Effect.void,
} satisfies V2RigdActionPreflightService)
