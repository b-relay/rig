import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import type { V2DeploymentRecord } from "./deployments.js"
import { makeV2RuntimeJournal } from "./runtime-journal.js"
import type {
  V2DesiredDeploymentState,
  V2ManagedServiceFailure,
  V2PersistedRigdEvent,
  V2PersistedRigdReceipt,
  V2ProviderObservation,
  V2RigdHealthSummary,
  V2RigdPersistentState,
  V2RigdStateRootInput,
  V2RigdStateStoreService,
} from "./rigd-state.js"

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

const deployment = {
  project: "pantry",
  name: "local",
  kind: "local",
  branch: "main",
  workspacePath: "/tmp/pantry",
  dataRoot: "/tmp/pantry/.rig-data",
  domain: "pantry.test",
  assignedPorts: {
    web: 3070,
  },
  providerProfile: "stub",
  resolved: {
    project: "pantry",
    lane: "local",
    deploymentName: "local",
    branchSlug: "main",
    subdomain: "local",
    workspacePath: "/tmp/pantry",
    dataRoot: "/tmp/pantry/.rig-data",
    providerProfile: "stub",
    providers: {
      processSupervisor: "rigd",
    },
    preparedComponents: [],
    environment: {
      services: [],
    },
    v1Config: {
      name: "pantry",
      version: "0.0.0",
      environments: {
        dev: {
          services: [],
        },
      },
    },
  },
} satisfies V2DeploymentRecord

class CaptureStateStore implements V2RigdStateStoreService {
  readonly calls: string[] = []
  private state = emptyState()

  load(_input: V2RigdStateRootInput) {
    this.calls.push("load")
    return Effect.succeed(this.state)
  }

  appendEvent(input: { readonly event: V2PersistedRigdEvent }) {
    this.calls.push("appendEvent")
    this.state = {
      ...this.state,
      events: [...this.state.events, input.event],
    }
    return Effect.void
  }

  appendReceipt(input: { readonly receipt: V2PersistedRigdReceipt }) {
    this.calls.push("appendReceipt")
    this.state = {
      ...this.state,
      receipts: [...this.state.receipts, input.receipt],
    }
    return Effect.void
  }

  writeHealthSummary(input: { readonly summary: V2RigdHealthSummary }) {
    this.calls.push("writeHealthSummary")
    this.state = {
      ...this.state,
      healthSummaries: [...this.state.healthSummaries, input.summary],
    }
    return Effect.void
  }

  writeProviderObservations(input: { readonly observations: readonly V2ProviderObservation[] }) {
    this.calls.push("writeProviderObservations")
    this.state = {
      ...this.state,
      providerObservations: input.observations,
    }
    return Effect.void
  }

  writePortReservations(input: V2RigdStateStoreService extends { writePortReservations: (input: infer A) => unknown } ? A : never) {
    this.calls.push("writePortReservations")
    this.state = {
      ...this.state,
      portReservations: input.reservations,
    }
    return Effect.void
  }

  writeDeploymentSnapshot(input: V2RigdStateStoreService extends { writeDeploymentSnapshot: (input: infer A) => unknown } ? A : never) {
    this.calls.push("writeDeploymentSnapshot")
    this.state = {
      ...this.state,
      deploymentSnapshots: input.snapshots,
    }
    return Effect.void
  }

  writeDesiredDeployment(input: { readonly desired: V2DesiredDeploymentState }) {
    this.calls.push("writeDesiredDeployment")
    this.state = {
      ...this.state,
      desiredDeployments: [input.desired],
    }
    return Effect.void
  }

  appendManagedServiceFailure(input: { readonly failure: V2ManagedServiceFailure }) {
    this.calls.push("appendManagedServiceFailure")
    this.state = {
      ...this.state,
      managedServiceFailures: [...this.state.managedServiceFailures, input.failure],
    }
    return Effect.void
  }

  reconstructMinimum(_input: V2RigdStateRootInput) {
    this.calls.push("reconstructMinimum")
    return Effect.succeed(this.state)
  }
}

describe("GIVEN v2 runtime journal WHEN recording rigd evidence THEN state writes stay behind the journal boundary", () => {
  test("GIVEN action health inventory desired-state and failure evidence WHEN recorded THEN persisted state remains readable", async () => {
    const store = new CaptureStateStore()
    const mirroredEvents: V2PersistedRigdEvent[] = []
    const journal = makeV2RuntimeJournal({
      stateStore: store,
      now: () => "2026-05-01T00:00:00.000Z",
      onEvent: (event) => mirroredEvents.push(event),
    })

    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        yield* journal.recordHealth({
          stateRoot: "/tmp/rig-v2",
          providerProfile: "stub",
          providers: [{
            id: "rigd",
            family: "process-supervisor",
            status: "confirmed",
            capabilities: ["lifecycle"],
          }],
        })
        yield* journal.recordDeploymentInventory({
          stateRoot: "/tmp/rig-v2",
          deployments: [deployment],
        })
        yield* journal.recordDesiredDeployment({
          stateRoot: "/tmp/rig-v2",
          deployment,
          desiredStatus: "running",
        })
        yield* journal.recordManagedServiceFailure({
          stateRoot: "/tmp/rig-v2",
          failure: {
            project: "pantry",
            deployment: "local",
            component: "web",
            occurredAt: "2026-05-01T00:00:00.000Z",
            exitCode: 1,
          },
        })
        const accepted = yield* journal.recordReceipt({
          kind: "lifecycle",
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          target: "local",
        })
        yield* journal.recordEvent({
          stateRoot: "/tmp/rig-v2",
          event: {
            event: "rigd.lifecycle.accepted",
            project: "pantry",
            lane: "local",
            details: {
              receiptId: accepted.id,
            },
          },
        })
        return accepted
      }),
    )

    expect(receipt).toMatchObject({
      id: "rigd-1",
      kind: "lifecycle",
      accepted: true,
      project: "pantry",
      target: "local",
      receivedAt: "2026-05-01T00:00:00.000Z",
    })
    expect(mirroredEvents).toEqual([
      expect.objectContaining({
        timestamp: "2026-05-01T00:00:00.000Z",
        event: "rigd.lifecycle.accepted",
        project: "pantry",
      }),
    ])
    expect(store.calls).toEqual([
      "writeHealthSummary",
      "writeProviderObservations",
      "writeDeploymentSnapshot",
      "writePortReservations",
      "writeDesiredDeployment",
      "appendManagedServiceFailure",
      "load",
      "appendReceipt",
      "appendEvent",
    ])
    const state = await Effect.runPromise(store.load({ stateRoot: "/tmp/rig-v2" }))
    expect(state).toMatchObject({
      receipts: [expect.objectContaining({ id: "rigd-1" })],
      events: [expect.objectContaining({ event: "rigd.lifecycle.accepted" })],
      healthSummaries: [expect.objectContaining({ providerProfile: "stub" })],
      providerObservations: [expect.objectContaining({ id: "rigd" })],
      deploymentSnapshots: [expect.objectContaining({ deployment: "local" })],
      portReservations: [expect.objectContaining({ component: "web", port: 3070 })],
      desiredDeployments: [expect.objectContaining({ deployment: "local", desiredStatus: "running" })],
      managedServiceFailures: [expect.objectContaining({ component: "web", exitCode: 1 })],
    })
  })
})
