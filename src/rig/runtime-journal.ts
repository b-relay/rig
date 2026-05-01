import { Effect } from "effect"

import type { RigDeploymentRecord } from "./deployments.js"
import type { RigRuntimeError } from "./errors.js"
import type { RigProviderFamily, RigProviderProfileName } from "./provider-contracts.js"
import type {
  RigDeploymentSnapshot,
  RigDesiredDeploymentState,
  RigManagedServiceFailure,
  RigPersistedRigdEvent,
  RigPersistedRigdReceipt,
  RigPortReservation,
  RigProviderObservation,
  RigdStateStoreService,
} from "./rigd-state.js"
import type { RigRuntimeExecutionResult } from "./runtime-executor.js"

export interface RigRuntimeJournalProviderObservationInput {
  readonly id: string
  readonly family: RigProviderFamily
  readonly status: RigProviderObservation["status"]
  readonly capabilities: readonly string[]
}

export interface RigRuntimeJournalOptions {
  readonly stateStore: RigdStateStoreService
  readonly now: () => string
  readonly receiptId?: () => string
  readonly onEvent?: (event: RigPersistedRigdEvent) => void
}

export interface RigRuntimeJournal {
  readonly recordHealth: (input: {
    readonly stateRoot: string
    readonly providerProfile: RigProviderProfileName
    readonly providers: readonly RigRuntimeJournalProviderObservationInput[]
  }) => Effect.Effect<void, RigRuntimeError>
  readonly recordDeploymentInventory: (input: {
    readonly stateRoot: string
    readonly deployments: readonly RigDeploymentRecord[]
  }) => Effect.Effect<void, RigRuntimeError>
  readonly recordReceipt: (input: {
    readonly kind: RigPersistedRigdReceipt["kind"]
    readonly project: string
    readonly stateRoot: string
    readonly target: string
  }) => Effect.Effect<RigPersistedRigdReceipt, RigRuntimeError>
  readonly recordEvent: (input: {
    readonly stateRoot: string
    readonly event: Omit<RigPersistedRigdEvent, "timestamp">
  }) => Effect.Effect<void, RigRuntimeError>
  readonly recordExecutionEvents: (input: {
    readonly stateRoot: string
    readonly execution?: RigRuntimeExecutionResult
  }) => Effect.Effect<void, RigRuntimeError>
  readonly recordDesiredDeployment: (input: {
    readonly stateRoot: string
    readonly deployment: RigDeploymentRecord
    readonly desiredStatus: RigDesiredDeploymentState["desiredStatus"]
  }) => Effect.Effect<void, RigRuntimeError>
  readonly recordManagedServiceFailure: (input: {
    readonly stateRoot: string
    readonly failure: RigManagedServiceFailure
  }) => Effect.Effect<void, RigRuntimeError>
}

export const makeRigRuntimeJournal = ({
  stateStore,
  now,
  receiptId = () => `rigd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  onEvent,
}: RigRuntimeJournalOptions): RigRuntimeJournal => {
  const recordEvent = (input: {
    readonly stateRoot: string
    readonly event: Omit<RigPersistedRigdEvent, "timestamp">
  }): Effect.Effect<void, RigRuntimeError> =>
    Effect.gen(function* () {
      const event = {
        timestamp: now(),
        ...input.event,
      } satisfies RigPersistedRigdEvent
      onEvent?.(event)
      yield* stateStore.appendEvent({
        stateRoot: input.stateRoot,
        event,
      })
    })

  return {
    recordHealth: (input) =>
      Effect.gen(function* () {
        const observedAt = now()
        yield* stateStore.writeHealthSummary({
          stateRoot: input.stateRoot,
          summary: {
            service: "rigd",
            status: "running",
            checkedAt: observedAt,
            providerProfile: input.providerProfile,
          },
        })
        yield* stateStore.writeProviderObservations({
          stateRoot: input.stateRoot,
          observations: input.providers.map((provider) => ({
            id: provider.id,
            family: provider.family,
            status: provider.status,
            observedAt,
            capabilities: provider.capabilities,
          })),
        })
      }),
    recordDeploymentInventory: (input) => {
      const observedAt = now()
      const snapshots: readonly RigDeploymentSnapshot[] = input.deployments.map((deployment) => ({
        project: deployment.project,
        deployment: deployment.name,
        kind: deployment.kind,
        observedAt,
        providerProfile: deployment.providerProfile,
      }))
      const reservations: readonly RigPortReservation[] = input.deployments.flatMap((deployment) =>
        Object.entries(deployment.assignedPorts).map(([component, port]) => ({
          project: deployment.project,
          deployment: deployment.name,
          component,
          port,
          owner: "rigd" as const,
          status: "reserved" as const,
          observedAt,
        })),
      )

      return Effect.gen(function* () {
        yield* stateStore.writeDeploymentSnapshot({
          stateRoot: input.stateRoot,
          snapshots,
        })
        yield* stateStore.writePortReservations({
          stateRoot: input.stateRoot,
          reservations,
        })
      })
    },
    recordReceipt: (input) =>
      Effect.gen(function* () {
        const accepted = {
          id: receiptId(),
          kind: input.kind,
          accepted: true,
          project: input.project,
          stateRoot: input.stateRoot,
          target: input.target,
          receivedAt: now(),
        } satisfies RigPersistedRigdReceipt

        yield* stateStore.appendReceipt({
          stateRoot: input.stateRoot,
          receipt: accepted,
        })

        return accepted
      }),
    recordEvent,
    recordExecutionEvents: (input) =>
      Effect.gen(function* () {
        for (const event of input.execution?.events ?? []) {
          yield* recordEvent({
            stateRoot: input.stateRoot,
            event,
          })
        }
      }),
    recordDesiredDeployment: (input) =>
      stateStore.writeDesiredDeployment({
        stateRoot: input.stateRoot,
        desired: {
          project: input.deployment.project,
          deployment: input.deployment.name,
          kind: input.deployment.kind,
          desiredStatus: input.desiredStatus,
          updatedAt: now(),
          providerProfile: input.deployment.providerProfile,
          record: input.deployment,
        },
      }),
    recordManagedServiceFailure: (input) =>
      stateStore.appendManagedServiceFailure({
        stateRoot: input.stateRoot,
        failure: input.failure,
      }),
  }
}
