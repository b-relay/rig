import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v4"

import { runRig2Cli } from "./cli.js"
import { V2CliArgumentError, type V2TaggedError } from "./errors.js"
import { V2Lifecycle, type V2LifecycleRequest } from "./lifecycle.js"
import { V2ProjectLocator } from "./project-locator.js"
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

class CaptureV2Lifecycle {
  readonly requests: V2LifecycleRequest[] = []

  run(request: V2LifecycleRequest) {
    this.requests.push(request)
    return Effect.void
  }
}

const runWithLogger = async (
  argv: readonly string[],
  options: {
    readonly inferredProject?: string
  } = {},
) => {
  const logger = new CaptureV2Logger()
  const lifecycle = new CaptureV2Lifecycle()
  const layer = Layer.mergeAll(
    V2RuntimeLive,
    Layer.succeed(V2Logger, logger),
    Layer.succeed(V2Lifecycle, lifecycle),
    Layer.succeed(V2ProjectLocator, {
      inferCurrentProject: options.inferredProject
        ? Effect.succeed({
          name: options.inferredProject,
          repoPath: "/tmp/repo",
          configPath: "/tmp/repo/rig.json",
        })
        : Effect.fail(
          new V2CliArgumentError(
            "No rig.json found in the current directory.",
            "Run the command from a managed repo or pass --project <name> explicitly.",
          ),
        ),
    }),
  )
  const exitCode = await Effect.runPromise(runRig2Cli(argv).pipe(Effect.provide(layer)))

  return { exitCode, logger, lifecycle }
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

  test("GIVEN up without project inside managed repo WHEN running THEN it infers project and targets local lane", async () => {
    const { exitCode, logger, lifecycle } = await runWithLogger(["up"], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(lifecycle.requests).toEqual([
      {
        action: "up",
        project: "pantry",
        lane: "local",
        stateRoot: expect.stringContaining(".rig-v2"),
      },
    ])
  })

  test("GIVEN logs with explicit project and live lane WHEN running THEN lifecycle request includes log options", async () => {
    const { exitCode, lifecycle } = await runWithLogger([
      "logs",
      "--project",
      "pantry",
      "--lane",
      "live",
      "--lines",
      "25",
      "--follow",
    ])

    expect(exitCode).toBe(0)
    expect(lifecycle.requests[0]).toMatchObject({
      action: "logs",
      project: "pantry",
      lane: "live",
      lines: 25,
      follow: true,
    })
  })

  test("GIVEN repo-first command outside managed repo WHEN project is omitted THEN it logs a tagged argument error", async () => {
    const { exitCode, logger, lifecycle } = await runWithLogger(["up"])

    expect(exitCode).toBe(1)
    expect(lifecycle.requests).toEqual([])
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]?._tag).toBe("V2CliArgumentError")
    expect(logger.errors[0]?.message).toContain("No rig.json")
  })

  test("GIVEN down destroy on local lane WHEN running THEN destroy is rejected as reserved", async () => {
    const { exitCode, logger, lifecycle } = await runWithLogger([
      "down",
      "--project",
      "pantry",
      "--destroy",
    ])

    expect(exitCode).toBe(1)
    expect(lifecycle.requests).toEqual([])
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]?.message).toContain("reserved for generated deployments")
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
