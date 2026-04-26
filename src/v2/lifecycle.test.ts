import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v4"

import { V2Lifecycle, V2LifecycleLive } from "./lifecycle.js"
import type { V2ProjectConfig } from "./config.js"
import { V2Rigd, type V2RigdLifecycleInput, type V2RigdLogInput, type V2RigdHealthStateInput } from "./rigd.js"
import { V2Logger, type V2LoggerService } from "./services.js"

class CaptureV2Logger implements V2LoggerService {
  readonly infos: Array<{ readonly message: string; readonly details?: unknown }> = []
  readonly errors: unknown[] = []

  info(message: string, details?: unknown) {
    this.infos.push({ message, details })
    return Effect.void
  }

  error(error: never) {
    this.errors.push(error)
    return Effect.void
  }
}

class CaptureV2Rigd {
  readonly lifecycleRequests: V2RigdLifecycleInput[] = []
  readonly logRequests: V2RigdLogInput[] = []
  readonly healthStateRequests: V2RigdHealthStateInput[] = []

  start() {
    return Effect.die("unused")
  }

  health() {
    return Effect.die("unused")
  }

  inventory() {
    return Effect.die("unused")
  }

  logs(input: V2RigdLogInput) {
    this.logRequests.push(input)
    return Effect.succeed([
      {
        timestamp: "2026-04-24T00:00:00.000Z",
        event: "rigd.lifecycle.accepted",
        project: input.project,
        lane: "local",
      },
    ])
  }

  healthState(input: V2RigdHealthStateInput) {
    this.healthStateRequests.push(input)
    return Effect.succeed({
      rigd: {
        service: "rigd" as const,
        status: "running" as const,
        stateRoot: input.stateRoot,
        startedAt: "2026-04-24T00:00:00.000Z",
        localApi: {
          transport: "in-process" as const,
          version: "v2-mvp" as const,
        },
        controlPlane: {
          website: "https://rig.b-relay.com" as const,
          transport: "localhost-http" as const,
          bindHost: "127.0.0.1" as const,
          exposure: "localhost-first" as const,
          remoteAccess: ["tailscale-dns", "cloudflare-tunnel-plugin"] as const,
          auth: {
            tailscale: "not-required" as const,
            publicInternet: "token-pairing" as const,
          },
          status: "documented-localhost-first" as const,
        },
      },
      deployments: [],
    })
  }

  lifecycle(input: V2RigdLifecycleInput) {
    this.lifecycleRequests.push(input)
    return Effect.succeed({
      id: "rigd-1",
      kind: "lifecycle" as const,
      accepted: true as const,
      project: input.project,
      stateRoot: input.stateRoot,
      target: input.lane,
      receivedAt: "2026-04-24T00:00:00.000Z",
    })
  }

  deploy() {
    return Effect.die("unused")
  }
}

const runWithLifecycle = async <A>(effect: Effect.Effect<A, unknown, V2Lifecycle>) => {
  const logger = new CaptureV2Logger()
  const rigd = new CaptureV2Rigd()
  const layer = Layer.provide(
    V2LifecycleLive,
    Layer.mergeAll(
      Layer.succeed(V2Logger, logger),
      Layer.succeed(V2Rigd, rigd),
    ),
  )
  const result = await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { result, logger, rigd }
}

describe("GIVEN v2 lifecycle live service WHEN runtime-facing actions run THEN rigd is the source of truth", () => {
  test("GIVEN up and down WHEN running THEN lifecycle actions are accepted by rigd", async () => {
    const config = {
      name: "pantry",
      components: {
        web: {
          mode: "managed" as const,
          command: "bun run start -- --port ${port.web}",
        },
      },
    } satisfies V2ProjectConfig
    const { rigd, logger } = await runWithLifecycle(
      Effect.gen(function* () {
        const lifecycle = yield* V2Lifecycle
        yield* lifecycle.run({
          action: "up",
          project: "pantry",
          lane: "local",
          stateRoot: "/tmp/rig-v2",
          config,
        })
        yield* lifecycle.run({
          action: "down",
          project: "pantry",
          lane: "local",
          stateRoot: "/tmp/rig-v2",
        })
      }),
    )

    expect(rigd.lifecycleRequests.map((request) => request.action)).toEqual(["up", "down"])
    expect(rigd.lifecycleRequests[0]?.config).toEqual(config)
    expect(logger.infos.map((entry) => entry.message)).toEqual([
      "rig2 lifecycle accepted",
      "rig2 lifecycle accepted",
    ])
  })

  test("GIVEN logs WHEN running THEN structured rigd logs are returned", async () => {
    const { rigd, logger } = await runWithLifecycle(
      Effect.gen(function* () {
        const lifecycle = yield* V2Lifecycle
        yield* lifecycle.run({
          action: "logs",
          project: "pantry",
          lane: "local",
          stateRoot: "/tmp/rig-v2",
          lines: 25,
          follow: true,
        })
      }),
    )

    expect(rigd.logRequests).toEqual([
      {
        project: "pantry",
        stateRoot: "/tmp/rig-v2",
        lines: 25,
      },
    ])
    expect(logger.infos[0]?.message).toBe("rig2 logs")
    expect(logger.infos[0]?.details).toMatchObject({
      follow: true,
      entries: [
        {
          event: "rigd.lifecycle.accepted",
          project: "pantry",
        },
      ],
    })
  })

  test("GIVEN status WHEN running THEN health and deployment state come from rigd", async () => {
    const config = {
      name: "pantry",
      components: {
        web: {
          mode: "managed" as const,
          command: "bun run start -- --port ${port.web}",
        },
      },
    } satisfies V2ProjectConfig
    const { rigd, logger } = await runWithLifecycle(
      Effect.gen(function* () {
        const lifecycle = yield* V2Lifecycle
        yield* lifecycle.run({
          action: "status",
          project: "pantry",
          lane: "live",
          stateRoot: "/tmp/rig-v2",
          config,
        })
      }),
    )

    expect(rigd.healthStateRequests).toEqual([
      {
        project: "pantry",
        stateRoot: "/tmp/rig-v2",
        config,
      },
    ])
    expect(logger.infos[0]?.message).toBe("rig2 runtime status")
    expect(logger.infos[0]?.details).toMatchObject({
      rigd: {
        status: "running",
      },
      deployments: [],
    })
  })
})
