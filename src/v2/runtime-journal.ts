import { Effect } from "effect"

import type { V2DeploymentRecord } from "./deployments.js"
import type { V2RuntimeError } from "./errors.js"
import type { V2ProviderFamily, V2ProviderProfileName } from "./provider-contracts.js"
import type {
  V2DeploymentSnapshot,
  V2DesiredDeploymentState,
  V2ManagedServiceFailure,
  V2PersistedRigdEvent,
  V2PersistedRigdReceipt,
  V2PortReservation,
  V2ProviderObservation,
  V2RigdStateStoreService,
} from "./rigd-state.js"
import type { V2RuntimeExecutionResult } from "./runtime-executor.js"

export interface V2RuntimeJournalProviderObservationInput {
  readonly id: string
  readonly family: V2ProviderFamily
  readonly status: V2ProviderObservation["status"]
  readonly capabilities: readonly string[]
}

export interface V2RuntimeJournalOptions {
  readonly stateStore: V2RigdStateStoreService
  readonly now: () => string
  readonly onEvent?: (event: V2PersistedRigdEvent) => void
}

export interface V2RuntimeJournal {
  readonly recordHealth: (input: {
    readonly stateRoot: string
    readonly providerProfile: V2ProviderProfileName
    readonly providers: readonly V2RuntimeJournalProviderObservationInput[]
  }) => Effect.Effect<void, V2RuntimeError>
  readonly recordDeploymentInventory: (input: {
    readonly stateRoot: string
    readonly deployments: readonly V2DeploymentRecord[]
  }) => Effect.Effect<void, V2RuntimeError>
  readonly recordReceipt: (input: {
    readonly kind: V2PersistedRigdReceipt["kind"]
    readonly project: string
    readonly stateRoot: string
    readonly target: string
  }) => Effect.Effect<V2PersistedRigdReceipt, V2RuntimeError>
  readonly recordEvent: (input: {
    readonly stateRoot: string
    readonly event: Omit<V2PersistedRigdEvent, "timestamp">
  }) => Effect.Effect<void, V2RuntimeError>
  readonly recordExecutionEvents: (input: {
    readonly stateRoot: string
    readonly execution?: V2RuntimeExecutionResult
  }) => Effect.Effect<void, V2RuntimeError>
  readonly recordDesiredDeployment: (input: {
    readonly stateRoot: string
    readonly deployment: V2DeploymentRecord
    readonly desiredStatus: V2DesiredDeploymentState["desiredStatus"]
  }) => Effect.Effect<void, V2RuntimeError>
  readonly recordManagedServiceFailure: (input: {
    readonly stateRoot: string
    readonly failure: V2ManagedServiceFailure
  }) => Effect.Effect<void, V2RuntimeError>
}

export const makeV2RuntimeJournal = ({
  stateStore,
  now,
  onEvent,
}: V2RuntimeJournalOptions): V2RuntimeJournal => {
  const recordEvent = (input: {
    readonly stateRoot: string
    readonly event: Omit<V2PersistedRigdEvent, "timestamp">
  }): Effect.Effect<void, V2RuntimeError> =>
    Effect.gen(function* () {
      const event = {
        timestamp: now(),
        ...input.event,
      } satisfies V2PersistedRigdEvent
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
      const snapshots: readonly V2DeploymentSnapshot[] = input.deployments.map((deployment) => ({
        project: deployment.project,
        deployment: deployment.name,
        kind: deployment.kind,
        observedAt,
        providerProfile: deployment.providerProfile,
      }))
      const reservations: readonly V2PortReservation[] = input.deployments.flatMap((deployment) =>
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
        const persisted = yield* stateStore.load({ stateRoot: input.stateRoot })
        const accepted = {
          id: `rigd-${persisted.receipts.length + 1}`,
          kind: input.kind,
          accepted: true,
          project: input.project,
          stateRoot: input.stateRoot,
          target: input.target,
          receivedAt: now(),
        } satisfies V2PersistedRigdReceipt

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
