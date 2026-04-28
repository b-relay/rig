import { join } from "node:path"
import { Context, Effect, Layer } from "effect"

import type { V2DeploymentKind, V2DeploymentRecord } from "./deployments.js"
import {
  isPlatformNotFound,
  platformMakeDirectory,
  platformReadFileString,
  platformWriteFileString,
} from "./effect-platform.js"
import { V2RuntimeError } from "./errors.js"
import type { V2ProviderFamily, V2ProviderProfileName } from "./provider-contracts.js"

export interface V2PersistedRigdEvent {
  readonly timestamp: string
  readonly event: string
  readonly project?: string
  readonly lane?: string
  readonly deployment?: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2PersistedRigdReceipt {
  readonly id: string
  readonly kind: "lifecycle" | "deploy" | "destroy"
  readonly accepted: true
  readonly project: string
  readonly stateRoot: string
  readonly target: string
  readonly receivedAt: string
}

export interface V2RigdHealthSummary {
  readonly service: "rigd"
  readonly status: "running"
  readonly checkedAt: string
  readonly providerProfile: V2ProviderProfileName
}

export interface V2ProviderObservation {
  readonly id: string
  readonly family: V2ProviderFamily
  readonly status: "confirmed" | "stale" | "missing"
  readonly observedAt: string
  readonly capabilities: readonly string[]
}

export interface V2PortReservation {
  readonly project: string
  readonly deployment: string
  readonly component: string
  readonly port: number
  readonly owner: "rigd"
  readonly status: "reserved" | "stale"
  readonly observedAt: string
}

export interface V2DeploymentSnapshot {
  readonly project: string
  readonly deployment: string
  readonly kind: V2DeploymentKind
  readonly observedAt: string
  readonly providerProfile: V2ProviderProfileName
}

export interface V2DesiredDeploymentState {
  readonly project: string
  readonly deployment: string
  readonly kind: V2DeploymentKind
  readonly desiredStatus: "running" | "stopped" | "failed"
  readonly updatedAt: string
  readonly providerProfile: V2ProviderProfileName
  readonly record: V2DeploymentRecord
}

export interface V2ManagedServiceFailure {
  readonly project: string
  readonly deployment: string
  readonly component: string
  readonly occurredAt: string
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

export interface V2RigdPersistentState {
  readonly version: 1
  readonly events: readonly V2PersistedRigdEvent[]
  readonly receipts: readonly V2PersistedRigdReceipt[]
  readonly healthSummaries: readonly V2RigdHealthSummary[]
  readonly providerObservations: readonly V2ProviderObservation[]
  readonly portReservations: readonly V2PortReservation[]
  readonly deploymentSnapshots: readonly V2DeploymentSnapshot[]
  readonly desiredDeployments: readonly V2DesiredDeploymentState[]
  readonly managedServiceFailures: readonly V2ManagedServiceFailure[]
}

export interface V2RigdStateRootInput {
  readonly stateRoot: string
}

export interface V2RigdStateStoreService {
  readonly load: (input: V2RigdStateRootInput) => Effect.Effect<V2RigdPersistentState, V2RuntimeError>
  readonly appendEvent: (input: {
    readonly stateRoot: string
    readonly event: V2PersistedRigdEvent
  }) => Effect.Effect<void, V2RuntimeError>
  readonly appendReceipt: (input: {
    readonly stateRoot: string
    readonly receipt: V2PersistedRigdReceipt
  }) => Effect.Effect<void, V2RuntimeError>
  readonly writeHealthSummary: (input: {
    readonly stateRoot: string
    readonly summary: V2RigdHealthSummary
  }) => Effect.Effect<void, V2RuntimeError>
  readonly writeProviderObservations: (input: {
    readonly stateRoot: string
    readonly observations: readonly V2ProviderObservation[]
  }) => Effect.Effect<void, V2RuntimeError>
  readonly writePortReservations: (input: {
    readonly stateRoot: string
    readonly reservations: readonly V2PortReservation[]
  }) => Effect.Effect<void, V2RuntimeError>
  readonly writeDeploymentSnapshot: (input: {
    readonly stateRoot: string
    readonly snapshots: readonly V2DeploymentSnapshot[]
  }) => Effect.Effect<void, V2RuntimeError>
  readonly writeDesiredDeployment: (input: {
    readonly stateRoot: string
    readonly desired: V2DesiredDeploymentState
  }) => Effect.Effect<void, V2RuntimeError>
  readonly appendManagedServiceFailure: (input: {
    readonly stateRoot: string
    readonly failure: V2ManagedServiceFailure
  }) => Effect.Effect<void, V2RuntimeError>
  readonly reconstructMinimum: (input: V2RigdStateRootInput) => Effect.Effect<V2RigdPersistentState, V2RuntimeError>
}

export const V2RigdStateStore =
  Context.Service<V2RigdStateStoreService>("rig/v2/V2RigdStateStore")

const emptyState = (): V2RigdPersistentState => ({
  version: 1,
  events: [],
  receipts: [],
  healthSummaries: [],
  providerObservations: [],
  portReservations: [],
  deploymentSnapshots: [],
  desiredDeployments: [],
  managedServiceFailures: [],
})

const rigdStatePath = (stateRoot: string): string =>
  join(stateRoot, "runtime", "rigd-state.json")

const runtimeError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new V2RuntimeError(
    message,
    hint,
    {
      cause: cause instanceof Error ? cause.message : String(cause),
      ...(details ?? {}),
    },
  )

const normalizeState = (value: unknown): V2RigdPersistentState => {
  if (typeof value !== "object" || value === null) {
    return emptyState()
  }

  const record = value as Partial<V2RigdPersistentState>
  return {
    version: 1,
    events: Array.isArray(record.events) ? record.events : [],
    receipts: Array.isArray(record.receipts) ? record.receipts : [],
    healthSummaries: Array.isArray(record.healthSummaries) ? record.healthSummaries : [],
    providerObservations: Array.isArray(record.providerObservations) ? record.providerObservations : [],
    portReservations: Array.isArray(record.portReservations) ? record.portReservations : [],
    deploymentSnapshots: Array.isArray(record.deploymentSnapshots) ? record.deploymentSnapshots : [],
    desiredDeployments: Array.isArray(record.desiredDeployments) ? record.desiredDeployments : [],
    managedServiceFailures: Array.isArray(record.managedServiceFailures) ? record.managedServiceFailures : [],
  }
}

const hasMinimumEvidence = (state: V2RigdPersistentState) => ({
  healthSummaries: state.healthSummaries.length > 0,
  providerObservations: state.providerObservations.length > 0,
  deploymentSnapshots: state.deploymentSnapshots.length > 0,
})

const allEvidencePresent = (evidence: ReturnType<typeof hasMinimumEvidence>): boolean =>
  evidence.healthSummaries && evidence.providerObservations && evidence.deploymentSnapshots

const readState = (stateRoot: string): Effect.Effect<V2RigdPersistentState, V2RuntimeError> =>
  platformReadFileString(rigdStatePath(stateRoot)).pipe(
    Effect.matchEffect({
      onSuccess: (raw) => Effect.try({
        try: () => normalizeState(JSON.parse(raw) as unknown),
        catch: (cause) => cause,
      }),
      onFailure: (cause) => isPlatformNotFound(cause) ? Effect.succeed(emptyState()) : Effect.fail(cause),
    }),
    Effect.mapError(runtimeError(
      "Unable to read rigd persistent state.",
      "Ensure the v2 runtime state root is readable or repair runtime/rigd-state.json.",
      { stateRoot },
    )),
  )

const writeState = (
  stateRoot: string,
  state: V2RigdPersistentState,
): Effect.Effect<void, V2RuntimeError> =>
  Effect.gen(function* () {
    yield* platformMakeDirectory(join(stateRoot, "runtime"))
    yield* platformWriteFileString(rigdStatePath(stateRoot), `${JSON.stringify(state, null, 2)}\n`)
  }).pipe(
    Effect.mapError(runtimeError(
      "Unable to write rigd persistent state.",
      "Ensure the v2 runtime state root is writable and retry.",
      { stateRoot },
    )),
  )

const updateState = (
  stateRoot: string,
  update: (state: V2RigdPersistentState) => V2RigdPersistentState,
): Effect.Effect<void, V2RuntimeError> =>
  Effect.gen(function* () {
    const current = yield* readState(stateRoot)
    yield* writeState(stateRoot, update(current))
  })

const mergeDeploymentSnapshots = (
  existing: readonly V2DeploymentSnapshot[],
  next: readonly V2DeploymentSnapshot[],
): readonly V2DeploymentSnapshot[] => {
  const nextProjects = new Set(next.map((candidate) => candidate.project))
  return [
    ...existing.filter((current) => !nextProjects.has(current.project)),
    ...next,
  ]
}

const mergePortReservations = (
  existing: readonly V2PortReservation[],
  next: readonly V2PortReservation[],
): readonly V2PortReservation[] => {
  const nextProjects = new Set(next.map((candidate) => candidate.project))
  return [
    ...existing.filter((current) => !nextProjects.has(current.project)),
    ...next,
  ]
}

const mergeDesiredDeployment = (
  existing: readonly V2DesiredDeploymentState[],
  next: V2DesiredDeploymentState,
): readonly V2DesiredDeploymentState[] => [
  ...existing.filter((current) =>
    current.project !== next.project ||
    current.deployment !== next.deployment
  ),
  next,
]

const reconstructMinimum = (
  stateRoot: string,
  state: V2RigdPersistentState,
): Effect.Effect<V2RigdPersistentState, V2RuntimeError> => {
  const evidence = hasMinimumEvidence(state)

  if (!allEvidencePresent(evidence)) {
    return Effect.fail(
      new V2RuntimeError(
        "Cannot safely reconstruct rigd state.",
        "Start rigd and collect health, provider, and deployment evidence before reconstruction.",
        {
          reason: "unsafe-reconstruction",
          stateRoot,
          evidence,
        },
      ),
    )
  }

  return Effect.succeed(state)
}

export const V2FileRigdStateStoreLive = Layer.succeed(V2RigdStateStore, {
  load: (input) => readState(input.stateRoot),
  appendEvent: (input) =>
    updateState(input.stateRoot, (state) => ({
      ...state,
      events: [...state.events, input.event],
    })),
  appendReceipt: (input) =>
    updateState(input.stateRoot, (state) => ({
      ...state,
      receipts: [...state.receipts.filter((receipt) => receipt.id !== input.receipt.id), input.receipt],
    })),
  writeHealthSummary: (input) =>
    updateState(input.stateRoot, (state) => ({
      ...state,
      healthSummaries: [...state.healthSummaries, input.summary],
    })),
  writeProviderObservations: (input) =>
    updateState(input.stateRoot, (state) => ({
      ...state,
      providerObservations: input.observations,
    })),
  writePortReservations: (input) =>
    updateState(input.stateRoot, (state) => ({
      ...state,
      portReservations: mergePortReservations(state.portReservations, input.reservations),
    })),
  writeDeploymentSnapshot: (input) =>
    updateState(input.stateRoot, (state) => ({
      ...state,
      deploymentSnapshots: mergeDeploymentSnapshots(state.deploymentSnapshots, input.snapshots),
    })),
  writeDesiredDeployment: (input) =>
    updateState(input.stateRoot, (state) => ({
      ...state,
      desiredDeployments: mergeDesiredDeployment(state.desiredDeployments, input.desired),
    })),
  appendManagedServiceFailure: (input) =>
    updateState(input.stateRoot, (state) => ({
      ...state,
      managedServiceFailures: [...state.managedServiceFailures, input.failure],
    })),
  reconstructMinimum: (input) =>
    Effect.gen(function* () {
      const state = yield* readState(input.stateRoot)
      return yield* reconstructMinimum(input.stateRoot, state)
    }),
} satisfies V2RigdStateStoreService)

export const V2MemoryRigdStateStoreLive = () => {
  const states = new Map<string, V2RigdPersistentState>()
  const load = (stateRoot: string): V2RigdPersistentState => states.get(stateRoot) ?? emptyState()
  const save = (stateRoot: string, state: V2RigdPersistentState): void => {
    states.set(stateRoot, state)
  }
  const update = (
    stateRoot: string,
    apply: (state: V2RigdPersistentState) => V2RigdPersistentState,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      save(stateRoot, apply(load(stateRoot)))
    })

  return Layer.succeed(V2RigdStateStore, {
    load: (input) => Effect.succeed(load(input.stateRoot)),
    appendEvent: (input) =>
      update(input.stateRoot, (state) => ({
        ...state,
        events: [...state.events, input.event],
      })),
    appendReceipt: (input) =>
      update(input.stateRoot, (state) => ({
        ...state,
        receipts: [...state.receipts.filter((receipt) => receipt.id !== input.receipt.id), input.receipt],
      })),
    writeHealthSummary: (input) =>
      update(input.stateRoot, (state) => ({
        ...state,
        healthSummaries: [...state.healthSummaries, input.summary],
      })),
    writeProviderObservations: (input) =>
      update(input.stateRoot, (state) => ({
        ...state,
        providerObservations: input.observations,
      })),
    writePortReservations: (input) =>
      update(input.stateRoot, (state) => ({
        ...state,
        portReservations: mergePortReservations(state.portReservations, input.reservations),
      })),
    writeDeploymentSnapshot: (input) =>
      update(input.stateRoot, (state) => ({
        ...state,
        deploymentSnapshots: mergeDeploymentSnapshots(state.deploymentSnapshots, input.snapshots),
      })),
    writeDesiredDeployment: (input) =>
      update(input.stateRoot, (state) => ({
        ...state,
        desiredDeployments: mergeDesiredDeployment(state.desiredDeployments, input.desired),
      })),
    appendManagedServiceFailure: (input) =>
      update(input.stateRoot, (state) => ({
        ...state,
        managedServiceFailures: [...state.managedServiceFailures, input.failure],
      })),
    reconstructMinimum: (input) => reconstructMinimum(input.stateRoot, load(input.stateRoot)),
  } satisfies V2RigdStateStoreService)
}
