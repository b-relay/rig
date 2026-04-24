import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { ProcessManager } from "./interfaces/process-manager.js"
import { buildRigLayer, normalizeRigProviderProfile } from "./provider-profiles.js"

describe("GIVEN provider profile selection WHEN composing the main rig layer THEN behavior is covered", () => {
  test("GIVEN unknown profile input WHEN normalizing THEN default providers are selected", () => {
    expect(normalizeRigProviderProfile(undefined)).toBe("default")
    expect(normalizeRigProviderProfile("default")).toBe("default")
    expect(normalizeRigProviderProfile("invalid")).toBe("default")
    expect(normalizeRigProviderProfile("stub")).toBe("stub")
    expect(normalizeRigProviderProfile("isolated-e2e")).toBe("isolated-e2e")
  })

  test("GIVEN stub provider profile WHEN layer is used THEN process management is test-safe", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const processManager = yield* ProcessManager
        yield* processManager.start("com.b-relay.rig.test")
        return yield* processManager.status("com.b-relay.rig.test")
      }).pipe(Effect.provide(buildRigLayer(false, false, "stub") as never)),
    )

    expect(status).toMatchObject({
      label: "com.b-relay.rig.test",
      loaded: true,
      running: true,
    })
    expect(typeof status.pid).toBe("number")
  })
})
