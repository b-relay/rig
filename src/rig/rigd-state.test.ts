import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { RigProviderRegistryLive } from "./provider-contracts.js"
import {
  RigFileRigdStateStoreLive,
  RigdStateStore,
} from "./rigd-state.js"

const runWithFileStore = <A>(effect: Effect.Effect<A, unknown, RigdStateStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(RigFileRigdStateStoreLive)))

describe("GIVEN rigd persistent state WHEN written under the rig root THEN restart evidence is durable", () => {
  test("GIVEN runtime evidence WHEN persisted THEN it can be loaded by a fresh store", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-rigd-state-"))

    try {
      await runWithFileStore(
        Effect.gen(function* () {
          const store = yield* RigdStateStore
          yield* store.appendEvent({
            stateRoot,
            event: {
              timestamp: "2026-04-25T00:00:00.000Z",
              event: "rigd.started",
            },
          })
          yield* store.appendReceipt({
            stateRoot,
            receipt: {
              id: "rigd-1",
              kind: "lifecycle",
              accepted: true,
              project: "pantry",
              stateRoot,
              target: "local",
              receivedAt: "2026-04-25T00:00:01.000Z",
            },
          })
          yield* store.writeHealthSummary({
            stateRoot,
            summary: {
              service: "rigd",
              status: "running",
              checkedAt: "2026-04-25T00:00:02.000Z",
              providerProfile: "default",
            },
          })
        }),
      )

      const loaded = await runWithFileStore(
        Effect.gen(function* () {
          const store = yield* RigdStateStore
          return yield* store.load({ stateRoot })
        }),
      )

      expect(loaded.events.map((entry) => entry.event)).toEqual(["rigd.started"])
      expect(loaded.receipts.map((entry) => entry.id)).toEqual(["rigd-1"])
      expect(loaded.healthSummaries[0]).toMatchObject({
        service: "rigd",
        status: "running",
        providerProfile: "default",
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN missing recovery evidence WHEN reconstructing THEN a tagged unsafe reconstruction error is returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-rigd-state-"))

    try {
      const error = await runWithFileStore(
        Effect.gen(function* () {
          const store = yield* RigdStateStore
          return yield* store.reconstructMinimum({ stateRoot }).pipe(Effect.flip)
        }),
      )

      expect(error._tag).toBe("RigRuntimeError")
      expect(error.message).toContain("Cannot safely reconstruct rigd state")
      expect(error.hint).toContain("Start rigd")
      expect(error.details).toMatchObject({
        reason: "unsafe-reconstruction",
        evidence: {
          healthSummaries: false,
          providerObservations: false,
          deploymentSnapshots: false,
        },
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN provider observations WHEN persisted THEN reconstruction separates confirmed and missing evidence", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-rigd-state-"))

    try {
      const reconstructed = await runWithFileStore(
        Effect.gen(function* () {
          const store = yield* RigdStateStore
          yield* store.writeProviderObservations({
            stateRoot,
            observations: [
              {
                id: "launchd",
                family: "process-supervisor",
                status: "confirmed",
                observedAt: "2026-04-25T00:00:00.000Z",
                capabilities: ["user-agent"],
              },
              {
                id: "missing-caddy",
                family: "proxy-router",
                status: "missing",
                observedAt: "2026-04-25T00:00:00.000Z",
                capabilities: [],
              },
            ],
          })
          yield* store.writeHealthSummary({
            stateRoot,
            summary: {
              service: "rigd",
              status: "running",
              checkedAt: "2026-04-25T00:00:01.000Z",
              providerProfile: "default",
            },
          })
          yield* store.writeDeploymentSnapshot({
            stateRoot,
            snapshots: [
              {
                project: "pantry",
                deployment: "live",
                kind: "live",
                observedAt: "2026-04-25T00:00:02.000Z",
                providerProfile: "default",
              },
            ],
          })
          return yield* store.reconstructMinimum({ stateRoot })
        }).pipe(Effect.provide(RigProviderRegistryLive("default"))),
      )

      expect(reconstructed.providerObservations.map((entry) => `${entry.status}:${entry.id}`)).toEqual([
        "confirmed:launchd",
        "missing:missing-caddy",
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
