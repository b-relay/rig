import { join } from "node:path"
import { Context, Effect, Layer } from "effect"

import type { RigDeploymentKind, RigDeploymentRecord } from "./deployments.js"
import {
  isPlatformNotFound,
  platformMakeDirectory,
  platformReadFileString,
  platformWriteFileString,
} from "./effect-platform.js"
import { RigRuntimeError } from "./errors.js"
import type { RigProviderFamily, RigProviderProfileName } from "./provider-contracts.js"

export interface RigPersistedRigdEvent {
  readonly timestamp: string
  readonly event: string
  readonly project?: string
  readonly lane?: string
  readonly deployment?: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigPersistedRigdReceipt {
  readonly id: string
  readonly kind: "lifecycle" | "deploy" | "destroy"
  readonly accepted: true
  readonly project: string
  readonly stateRoot: string
  readonly target: string
  readonly receivedAt: string
}

export interface RigdHealthSummary {
  readonly service: "rigd"
  readonly status: "running"
  readonly checkedAt: string
  readonly providerProfile: RigProviderProfileName
}

export interface RigProviderObservation {
  readonly id: string
  readonly family: RigProviderFamily
  readonly status: "confirmed" | "stale" | "missing"
  readonly observedAt: string
  readonly capabilities: readonly string[]
}

export interface RigPortReservation {
  readonly project: string
  readonly deployment: string
  readonly component: string
  readonly port: number
  readonly owner: "rigd"
  readonly status: "reserved" | "stale"
  readonly observedAt: string
}

export interface RigDeploymentSnapshot {
  readonly project: string
  readonly deployment: string
  readonly kind: RigDeploymentKind
  readonly observedAt: string
  readonly providerProfile: RigProviderProfileName
}

export interface RigDesiredDeploymentState {
  readonly project: string
  readonly deployment: string
  readonly kind: RigDeploymentKind
  readonly desiredStatus: "running" | "stopped" | "failed"
  readonly updatedAt: string
  readonly providerProfile: RigProviderProfileName
  readonly record: RigDeploymentRecord
}

export interface RigManagedServiceFailure {
  readonly project: string
  readonly deployment: string
  readonly component: string
  readonly occurredAt: string
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

export interface RigdPersistentState {
  readonly version: 1
  readonly events: readonly RigPersistedRigdEvent[]
  readonly receipts: readonly RigPersistedRigdReceipt[]
  readonly healthSummaries: readonly RigdHealthSummary[]
  readonly providerObservations: readonly RigProviderObservation[]
  readonly portReservations: readonly RigPortReservation[]
  readonly deploymentSnapshots: readonly RigDeploymentSnapshot[]
  readonly desiredDeployments: readonly RigDesiredDeploymentState[]
  readonly managedServiceFailures: readonly RigManagedServiceFailure[]
}

export interface RigdStateRootInput {
  readonly stateRoot: string
}

export interface RigdStateStoreService {
  readonly load: (input: RigdStateRootInput) => Effect.Effect<RigdPersistentState, RigRuntimeError>
  readonly appendEvent: (input: {
    readonly stateRoot: string
    readonly event: RigPersistedRigdEvent
  }) => Effect.Effect<void, RigRuntimeError>
  readonly appendReceipt: (input: {
    readonly stateRoot: string
    readonly receipt: RigPersistedRigdReceipt
  }) => Effect.Effect<void, RigRuntimeError>
  readonly writeHealthSummary: (input: {
    readonly stateRoot: string
    readonly summary: RigdHealthSummary
  }) => Effect.Effect<void, RigRuntimeError>
  readonly writeProviderObservations: (input: {
    readonly stateRoot: string
    readonly observations: readonly RigProviderObservation[]
  }) => Effect.Effect<void, RigRuntimeError>
  readonly writePortReservations: (input: {
    readonly stateRoot: string
    readonly reservations: readonly RigPortReservation[]
  }) => Effect.Effect<void, RigRuntimeError>
  readonly writeDeploymentSnapshot: (input: {
    readonly stateRoot: string
    readonly snapshots: readonly RigDeploymentSnapshot[]
  }) => Effect.Effect<void, RigRuntimeError>
  readonly writeDesiredDeployment: (input: {
    readonly stateRoot: string
    readonly desired: RigDesiredDeploymentState
  }) => Effect.Effect<void, RigRuntimeError>
  readonly appendManagedServiceFailure: (input: {
    readonly stateRoot: string
    readonly failure: RigManagedServiceFailure
  }) => Effect.Effect<void, RigRuntimeError>
  readonly reconstructMinimum: (input: RigdStateRootInput) => Effect.Effect<RigdPersistentState, RigRuntimeError>
}

export const RigdStateStore =
  Context.Service<RigdStateStoreService>("rig/rig/RigdStateStore")

const emptyState = (): RigdPersistentState => ({
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
  new RigRuntimeError(
    message,
    hint,
    {
      cause: cause instanceof Error ? cause.message : String(cause),
      ...(details ?? {}),
    },
  )

const normalizeState = (value: unknown): RigdPersistentState => {
  if (typeof value !== "object" || value === null) {
    return emptyState()
  }

  const record = value as Partial<RigdPersistentState>
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

const hasMinimumEvidence = (state: RigdPersistentState) => ({
  healthSummaries: state.healthSummaries.length > 0,
  providerObservations: state.providerObservations.length > 0,
  deploymentSnapshots: state.deploymentSnapshots.length > 0,
})

const allEvidencePresent = (evidence: ReturnType<typeof hasMinimumEvidence>): boolean =>
  evidence.healthSummaries && evidence.providerObservations && evidence.deploymentSnapshots

const readState = (stateRoot: string): Effect.Effect<RigdPersistentState, RigRuntimeError> =>
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
      "Ensure the rig runtime state root is readable or repair runtime/rigd-state.json.",
      { stateRoot },
    )),
  )

const writeState = (
  stateRoot: string,
  state: RigdPersistentState,
): Effect.Effect<void, RigRuntimeError> =>
  Effect.gen(function* () {
    yield* platformMakeDirectory(join(stateRoot, "runtime"))
    yield* platformWriteFileString(rigdStatePath(stateRoot), `${JSON.stringify(state, null, 2)}\n`)
  }).pipe(
    Effect.mapError(runtimeError(
      "Unable to write rigd persistent state.",
      "Ensure the rig runtime state root is writable and retry.",
      { stateRoot },
    )),
  )

const updateState = (
  stateRoot: string,
  update: (state: RigdPersistentState) => RigdPersistentState,
): Effect.Effect<void, RigRuntimeError> =>
  Effect.gen(function* () {
    const current = yield* readState(stateRoot)
    yield* writeState(stateRoot, update(current))
  })

const mergeDeploymentSnapshots = (
  existing: readonly RigDeploymentSnapshot[],
  next: readonly RigDeploymentSnapshot[],
): readonly RigDeploymentSnapshot[] => {
  const nextProjects = new Set(next.map((candidate) => candidate.project))
  return [
    ...existing.filter((current) => !nextProjects.has(current.project)),
    ...next,
  ]
}

const mergePortReservations = (
  existing: readonly RigPortReservation[],
  next: readonly RigPortReservation[],
): readonly RigPortReservation[] => {
  const nextProjects = new Set(next.map((candidate) => candidate.project))
  return [
    ...existing.filter((current) => !nextProjects.has(current.project)),
    ...next,
  ]
}

const mergeDesiredDeployment = (
  existing: readonly RigDesiredDeploymentState[],
  next: RigDesiredDeploymentState,
): readonly RigDesiredDeploymentState[] => [
  ...existing.filter((current) =>
    current.project !== next.project ||
    current.deployment !== next.deployment
  ),
  next,
]

const reconstructMinimum = (
  stateRoot: string,
  state: RigdPersistentState,
): Effect.Effect<RigdPersistentState, RigRuntimeError> => {
  const evidence = hasMinimumEvidence(state)

  if (!allEvidencePresent(evidence)) {
    return Effect.fail(
      new RigRuntimeError(
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

export const RigFileRigdStateStoreLive = Layer.succeed(RigdStateStore, {
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
} satisfies RigdStateStoreService)

export const RigMemoryRigdStateStoreLive = () => {
  const states = new Map<string, RigdPersistentState>()
  const load = (stateRoot: string): RigdPersistentState => states.get(stateRoot) ?? emptyState()
  const save = (stateRoot: string, state: RigdPersistentState): void => {
    states.set(stateRoot, state)
  }
  const update = (
    stateRoot: string,
    apply: (state: RigdPersistentState) => RigdPersistentState,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      save(stateRoot, apply(load(stateRoot)))
    })

  return Layer.succeed(RigdStateStore, {
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
  } satisfies RigdStateStoreService)
}
