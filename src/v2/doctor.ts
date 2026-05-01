import { Context, Effect, Layer } from "effect"

import { V2RuntimeError } from "./errors.js"

export type V2DoctorCategory =
  | "dependencies"
  | "binaries"
  | "env"
  | "hooks"
  | "health"
  | "ports"
  | "path"
  | "stale-state"
  | "providers"

export interface V2NamedCheck {
  readonly name: string
  readonly ok: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2BinaryCheck {
  readonly path: string
  readonly ok: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2HookCheck {
  readonly name: string
  readonly ok: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2HealthOwnershipCheck {
  readonly component: string
  readonly target?: string
  readonly ok: boolean
  readonly ownedByRig: boolean
  readonly observedPid?: number
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2PortReservationCheck {
  readonly component: string
  readonly port: number
  readonly available: boolean
  readonly ownerPid?: number
  readonly ownerCommand?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2DoctorCheckInput {
  readonly project: string
  readonly deployment: string
  readonly dependencies: readonly V2NamedCheck[]
  readonly binaries: readonly V2BinaryCheck[]
  readonly env: readonly V2NamedCheck[]
  readonly hooks: readonly V2HookCheck[]
  readonly healthChecks: readonly V2HealthOwnershipCheck[]
  readonly ports: readonly V2PortReservationCheck[]
  readonly staleState: readonly V2NamedCheck[]
  readonly providers: readonly (V2NamedCheck & { readonly profile?: string })[]
}

export interface V2DoctorFailure {
  readonly category: V2DoctorCategory
  readonly component?: string
  readonly reason: string
  readonly message: string
  readonly hint: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2PreflightResult {
  readonly ok: boolean
  readonly project: string
  readonly deployment: string
  readonly checkedCategories: readonly V2DoctorCategory[]
  readonly failures: readonly V2DoctorFailure[]
}

export interface V2DoctorReportInput {
  readonly project: string
  readonly path: {
    readonly ok: boolean
    readonly entries: readonly string[]
  }
  readonly binaries: readonly V2BinaryCheck[]
  readonly health: readonly V2HealthOwnershipCheck[]
  readonly ports: readonly V2PortReservationCheck[]
  readonly staleState: readonly V2NamedCheck[]
  readonly providers: readonly (V2NamedCheck & { readonly profile: string })[]
}

export interface V2DoctorCategoryReport {
  readonly category: V2DoctorCategory
  readonly ok: boolean
  readonly details: unknown
}

export interface V2DoctorReport {
  readonly project: string
  readonly ok: boolean
  readonly categories: readonly V2DoctorCategoryReport[]
}

export interface V2ReconstructInput {
  readonly project: string
  readonly deployment: string
  readonly rigdAlive: boolean
  readonly providerStatePresent: boolean
  readonly deploymentInventoryPresent: boolean
  readonly gitRefPresent: boolean
}

export interface V2ReconstructPlan {
  readonly safe: true
  readonly project: string
  readonly deployment: string
  readonly steps: readonly string[]
}

export interface V2DoctorService {
  readonly preflight: (input: V2DoctorCheckInput) => Effect.Effect<V2PreflightResult>
  readonly report: (input: V2DoctorReportInput) => Effect.Effect<V2DoctorReport>
  readonly reconstruct: (input: V2ReconstructInput) => Effect.Effect<V2ReconstructPlan, V2RuntimeError>
}

export const V2Doctor = Context.Service<V2DoctorService>("rig/v2/V2Doctor")

const genericFailure = (
  category: V2DoctorCategory,
  name: string,
  details?: Readonly<Record<string, unknown>>,
): V2DoctorFailure => ({
  category,
  reason: "failed-check",
  message: `${category} check '${name}' failed.`,
  hint: `Fix '${name}' before deploying.`,
  details,
})

const healthFailure = (check: V2HealthOwnershipCheck): V2DoctorFailure => ({
  category: "health",
  component: check.component,
  reason: check.ownedByRig ? "health-failed" : "health-ownership",
  message: check.ownedByRig
    ? `Health check failed for component '${check.component}'.`
    : `Health check for component '${check.component}' matched a process not owned by rig.`,
  hint: check.ownedByRig
    ? "Fix the component health check before cutover."
    : "Stop the unrelated process or move the component to a rig-owned endpoint before cutover.",
  details: {
    target: check.target,
    observedPid: check.observedPid,
    ...(check.details ?? {}),
  },
})

const portFailure = (check: V2PortReservationCheck): V2DoctorFailure => ({
  category: "ports",
  component: check.component,
  reason: "port-conflict",
  message: `Port ${check.port} is not available for component '${check.component}'.`,
  hint: check.ownerPid
    ? `Stop PID ${check.ownerPid} or move component '${check.component}' to another port before cutover.`
    : `Free port ${check.port} or move component '${check.component}' to another port before cutover.`,
  details: {
    port: check.port,
    ownerPid: check.ownerPid,
    ownerCommand: check.ownerCommand,
    ...(check.details ?? {}),
  },
})

const collectPreflightFailures = (input: V2DoctorCheckInput): readonly V2DoctorFailure[] => [
  ...input.dependencies.filter((check) => !check.ok).map((check) => genericFailure("dependencies", check.name, check.details)),
  ...input.binaries.filter((check) => !check.ok).map((check) => genericFailure("binaries", check.path, check.details)),
  ...input.env.filter((check) => !check.ok).map((check) => genericFailure("env", check.name, check.details)),
  ...input.hooks.filter((check) => !check.ok).map((check) => genericFailure("hooks", check.name, check.details)),
  ...input.healthChecks.filter((check) => !check.ok || !check.ownedByRig).map(healthFailure),
  ...input.ports.filter((check) => !check.available).map(portFailure),
  ...input.staleState.filter((check) => !check.ok).map((check) => genericFailure("stale-state", check.name, check.details)),
  ...input.providers.filter((check) => !check.ok).map((check) => genericFailure("providers", check.name, check.details)),
]

const category = (
  categoryName: V2DoctorCategory,
  ok: boolean,
  details: unknown,
): V2DoctorCategoryReport => ({
  category: categoryName,
  ok,
  details,
})

export const evaluateV2Preflight = (input: V2DoctorCheckInput): V2PreflightResult => {
  const failures = collectPreflightFailures(input)
  return {
    ok: failures.length === 0,
    project: input.project,
    deployment: input.deployment,
    checkedCategories: ["dependencies", "binaries", "env", "hooks", "health", "ports", "stale-state", "providers"],
    failures,
  }
}

export const V2DoctorLive = Layer.succeed(V2Doctor, {
  preflight: (input) => Effect.succeed(evaluateV2Preflight(input)),
  report: (input) => {
    const categories = [
      category("path", input.path.ok, input.path),
      category("binaries", input.binaries.every((check) => check.ok), input.binaries),
      category("health", input.health.every((check) => check.ok && check.ownedByRig), input.health),
      category("ports", input.ports.every((check) => check.available), input.ports),
      category("stale-state", input.staleState.every((check) => check.ok), input.staleState),
      category("providers", input.providers.every((check) => check.ok), input.providers),
    ]

    return Effect.succeed({
      project: input.project,
      ok: categories.every((entry) => entry.ok),
      categories,
    })
  },
  reconstruct: (input) => {
    const safe =
      input.rigdAlive &&
      input.providerStatePresent &&
      input.deploymentInventoryPresent &&
      input.gitRefPresent

    if (!safe) {
      return Effect.fail(
        new V2RuntimeError(
          `Cannot safely reconstruct deployment '${input.deployment}'.`,
          "Restore missing rigd, provider, inventory, or git-ref evidence before reconstruction.",
          {
            project: input.project,
            deployment: input.deployment,
            reason: "unsafe-reconstruction",
            evidence: {
              rigdAlive: input.rigdAlive,
              providerStatePresent: input.providerStatePresent,
              deploymentInventoryPresent: input.deploymentInventoryPresent,
              gitRefPresent: input.gitRefPresent,
            },
          },
        ),
      )
    }

    return Effect.succeed({
      safe: true,
      project: input.project,
      deployment: input.deployment,
      steps: [
        "read-rigd-runtime-state",
        "read-provider-state",
        "read-deployment-inventory",
        "verify-git-ref",
        "rewrite-minimum-runtime-state",
      ],
    })
  },
} satisfies V2DoctorService)
