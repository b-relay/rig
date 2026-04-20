import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v4"

import { runRig2Cli } from "./cli.js"
import type { V2TaggedError } from "./errors.js"
import { V2Logger, V2RuntimeLive, type V2FoundationState } from "./services.js"

class CaptureV2Logger {
  readonly infos: Array<{ readonly message: string; readonly details?: unknown }> = []
  readonly errors: V2TaggedError[] = []

  info(message: string, details?: unknown) {
    this.infos.push({ message, details })
    return Effect.void
  }

  error(error: V2TaggedError) {
    this.errors.push(error)
    return Effect.void
  }
}

const runWithLogger = async (argv: readonly string[]) => {
  const logger = new CaptureV2Logger()
  const layer = Layer.mergeAll(V2RuntimeLive, Layer.succeed(V2Logger, logger))
  const exitCode = await Effect.runPromise(runRig2Cli(argv).pipe(Effect.provide(layer)))

  return { exitCode, logger }
}

describe("GIVEN rig2 Effect CLI foundation WHEN commands run THEN behavior is covered", () => {
  test("GIVEN status command with project and state root WHEN running THEN it reports isolated v2 state", async () => {
    const { exitCode, logger } = await runWithLogger([
      "status",
      "--project",
      "pantry",
      "--state-root",
      "/tmp/rig-v2",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(logger.infos).toHaveLength(1)
    expect(logger.infos[0]?.message).toBe("rig2 foundation ready")

    const state = logger.infos[0]?.details as unknown as V2FoundationState
    expect(state.project).toBe("pantry")
    expect(state.namespace).toBe("rig.v2.pantry")
    expect(state.stateRoot).toBe("/tmp/rig-v2")
    expect(state.registryPath).toBe("/tmp/rig-v2/registry.json")
    expect(state.workspacesRoot).toBe("/tmp/rig-v2/workspaces")
    expect(state.launchdLabelPrefix).toBe("com.b-relay.rig2")
  })

  test("GIVEN status command with invalid project WHEN running THEN schema failure is logged structurally", async () => {
    const { exitCode, logger } = await runWithLogger(["status", "--project", "../pantry"])

    expect(exitCode).toBe(1)
    expect(logger.infos).toEqual([])
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]?._tag).toBe("V2CliArgumentError")
    expect(logger.errors[0]?.details?.originalTag).toBe("V2ConfigValidationError")
  })
})
