import { Context, Effect, Layer } from "effect"

import { RigRuntimeError } from "./errors.js"

export type RigDoctorCategory =
  | "dependencies"
  | "binaries"
  | "env"
  | "hooks"
  | "health"
  | "ports"
  | "path"
  | "stale-state"
  | "providers"

export interface RigNamedCheck {
  readonly name: string
  readonly ok: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigBinaryCheck {
  readonly path: string
  readonly ok: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigHookCheck {
  readonly name: string
  readonly ok: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigHealthOwnershipCheck {
  readonly component: string
  readonly target?: string
  readonly ok: boolean
  readonly ownedByRig: boolean
  readonly observedPid?: number
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigPortReservationCheck {
  readonly component: string
  readonly port: number
  readonly available: boolean
  readonly ownerPid?: number
  readonly ownerCommand?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigDoctorProviderCheck extends RigNamedCheck {
  readonly profile?: string
  readonly providerId?: string
  readonly project?: string
  readonly deployment?: string
  readonly component?: string
  readonly reason?: string
  readonly message?: string
  readonly hint?: string
}

export interface RigDoctorCheckInput {
  readonly project: string
  readonly deployment: string
  readonly dependencies: readonly RigNamedCheck[]
  readonly binaries: readonly RigBinaryCheck[]
  readonly env: readonly RigNamedCheck[]
  readonly hooks: readonly RigHookCheck[]
  readonly healthChecks: readonly RigHealthOwnershipCheck[]
  readonly ports: readonly RigPortReservationCheck[]
  readonly staleState: readonly RigNamedCheck[]
  readonly providers: readonly RigDoctorProviderCheck[]
}

export interface RigDoctorFailure {
  readonly category: RigDoctorCategory
  readonly providerId?: string
  readonly project?: string
  readonly deployment?: string
  readonly component?: string
  readonly reason: string
  readonly message: string
  readonly hint: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigPreflightResult {
  readonly ok: boolean
  readonly project: string
  readonly deployment: string
  readonly checkedCategories: readonly RigDoctorCategory[]
  readonly failures: readonly RigDoctorFailure[]
}

export interface RigDoctorReportInput {
  readonly project: string
  readonly path: {
    readonly ok: boolean
    readonly entries: readonly string[]
  }
  readonly binaries: readonly RigBinaryCheck[]
  readonly health: readonly RigHealthOwnershipCheck[]
  readonly ports: readonly RigPortReservationCheck[]
  readonly staleState: readonly RigNamedCheck[]
  readonly providers: readonly RigDoctorProviderCheck[]
}

export interface RigDoctorCategoryReport {
  readonly category: RigDoctorCategory
  readonly ok: boolean
  readonly details: unknown
}

export interface RigDoctorReport {
  readonly project: string
  readonly ok: boolean
  readonly categories: readonly RigDoctorCategoryReport[]
  readonly diagnostics: readonly RigDoctorFailure[]
}

export interface RigReconstructInput {
  readonly project: string
  readonly deployment: string
  readonly rigdAlive: boolean
  readonly providerStatePresent: boolean
  readonly deploymentInventoryPresent: boolean
  readonly gitRefPresent: boolean
}

export interface RigReconstructPlan {
  readonly safe: true
  readonly project: string
  readonly deployment: string
  readonly steps: readonly string[]
}

export interface RigDoctorService {
  readonly preflight: (input: RigDoctorCheckInput) => Effect.Effect<RigPreflightResult>
  readonly report: (input: RigDoctorReportInput) => Effect.Effect<RigDoctorReport>
  readonly reconstruct: (input: RigReconstructInput) => Effect.Effect<RigReconstructPlan, RigRuntimeError>
}

export const RigDoctor = Context.Service<RigDoctorService>("rig/rig/RigDoctor")

const genericFailure = (
  category: RigDoctorCategory,
  name: string,
  details?: Readonly<Record<string, unknown>>,
): RigDoctorFailure => ({
  category,
  reason: "failed-check",
  message: `${category} check '${name}' failed.`,
  hint: `Fix '${name}' before deploying.`,
  details,
})

const healthFailure = (check: RigHealthOwnershipCheck): RigDoctorFailure => ({
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

const portFailure = (check: RigPortReservationCheck): RigDoctorFailure => ({
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

const providerFailure = (check: RigDoctorProviderCheck): RigDoctorFailure => {
  const providerId = check.providerId ?? check.name
  return {
    category: "providers",
    providerId,
    project: check.project,
    deployment: check.deployment,
    component: check.component,
    reason: check.reason ?? "failed-check",
    message: check.message ?? `Provider '${check.name}' check failed.`,
    hint: check.hint ?? `Fix provider '${check.name}' before continuing.`,
    details: {
      providerId,
      profile: check.profile,
      project: check.project,
      deployment: check.deployment,
      component: check.component,
      ...(check.details ?? {}),
    },
  }
}

const collectPreflightFailures = (input: RigDoctorCheckInput): readonly RigDoctorFailure[] => [
  ...input.dependencies.filter((check) => !check.ok).map((check) => genericFailure("dependencies", check.name, check.details)),
  ...input.binaries.filter((check) => !check.ok).map((check) => genericFailure("binaries", check.path, check.details)),
  ...input.env.filter((check) => !check.ok).map((check) => genericFailure("env", check.name, check.details)),
  ...input.hooks.filter((check) => !check.ok).map((check) => genericFailure("hooks", check.name, check.details)),
  ...input.healthChecks.filter((check) => !check.ok || !check.ownedByRig).map(healthFailure),
  ...input.ports.filter((check) => !check.available).map(portFailure),
  ...input.staleState.filter((check) => !check.ok).map((check) => genericFailure("stale-state", check.name, check.details)),
  ...input.providers.filter((check) => !check.ok).map(providerFailure),
]

const category = (
  categoryName: RigDoctorCategory,
  ok: boolean,
  details: unknown,
): RigDoctorCategoryReport => ({
  category: categoryName,
  ok,
  details,
})

export const evaluateRigPreflight = (input: RigDoctorCheckInput): RigPreflightResult => {
  const failures = collectPreflightFailures(input)
  return {
    ok: failures.length === 0,
    project: input.project,
    deployment: input.deployment,
    checkedCategories: ["dependencies", "binaries", "env", "hooks", "health", "ports", "stale-state", "providers"],
    failures,
  }
}

export const RigDoctorLive = Layer.succeed(RigDoctor, {
  preflight: (input) => Effect.succeed(evaluateRigPreflight(input)),
  report: (input) => {
    const diagnostics = input.providers.filter((check) => !check.ok).map(providerFailure)
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
      diagnostics,
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
        new RigRuntimeError(
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
} satisfies RigDoctorService)
