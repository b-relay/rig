import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v4"

import { decodeV2ProjectConfig } from "./config.js"
import {
  V2DeploymentManager,
  V2DeploymentManagerLive,
  V2DeploymentStore,
  type V2DeploymentRecord,
  type V2DeploymentStoreService,
} from "./deployments.js"
import { V2Rigd, V2RigdLive } from "./rigd.js"
import { V2Logger, V2RuntimeLive } from "./services.js"

class MemoryDeploymentStore implements V2DeploymentStoreService {
  readonly records = new Map<string, V2DeploymentRecord[]>()

  read(project: string, _stateRoot: string) {
    return Effect.succeed(this.records.get(project) ?? [])
  }

  write(project: string, _stateRoot: string, records: readonly V2DeploymentRecord[]) {
    this.records.set(project, [...records])
    return Effect.void
  }

  ensureState(_record: V2DeploymentRecord) {
    return Effect.void
  }

  removeState(_record: V2DeploymentRecord) {
    return Effect.void
  }
}

class CaptureV2Logger {
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

const projectConfig = () =>
  decodeV2ProjectConfig({
    name: "pantry",
    domain: "${subdomain}.preview.b-relay.com",
    components: {
      web: {
        mode: "managed",
        command: "bun run start -- --port ${port.web}",
        port: 3070,
        health: "http://127.0.0.1:${port.web}/health",
      },
    },
    deployments: {
      subdomain: "${branchSlug}",
      providerProfile: "stub",
    },
  })

const runWithRigd = async <A>(effect: Effect.Effect<A, unknown, V2Rigd | V2DeploymentManager>) => {
  const logger = new CaptureV2Logger()
  const deploymentStore = new MemoryDeploymentStore()
  const deploymentManagerLive = Layer.provide(
    V2DeploymentManagerLive,
    Layer.succeed(V2DeploymentStore, deploymentStore),
  )
  const layer = Layer.mergeAll(
    V2RuntimeLive,
    Layer.succeed(V2Logger, logger),
    deploymentManagerLive,
    Layer.provide(V2RigdLive, Layer.mergeAll(V2RuntimeLive, deploymentManagerLive, Layer.succeed(V2Logger, logger))),
  )
  const result = await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { result, logger, deploymentStore }
}

describe("GIVEN rigd MVP local API WHEN used through its interface THEN behavior is covered", () => {
  test("GIVEN rigd start WHEN health is requested THEN local runtime authority is reported", async () => {
    const { result } = await runWithRigd(
      Effect.gen(function* () {
        const rigd = yield* V2Rigd
        const started = yield* rigd.start({ stateRoot: "/tmp/rig-v2" })
        const health = yield* rigd.health({ stateRoot: "/tmp/rig-v2" })
        return { started, health }
      }),
    )

    expect(result.started).toMatchObject({
      service: "rigd",
      status: "running",
      stateRoot: "/tmp/rig-v2",
      localApi: {
        transport: "in-process",
        version: "v2-mvp",
      },
    })
    expect(result.health.status).toBe("running")
    expect(result.health.controlPlane.outboundOnly).toBe(true)
    expect(result.health.controlPlane.endpoint).toBe("https://core.b-relay.com")
  })

  test("GIVEN materialized deployments WHEN inventory is requested THEN project and deployment inventory are exposed", async () => {
    const config = await Effect.runPromise(projectConfig())
    const { result: inventory } = await runWithRigd(
      Effect.gen(function* () {
        const deploymentManager = yield* V2DeploymentManager
        yield* deploymentManager.materializeGenerated({
          config,
          stateRoot: "/tmp/rig-v2",
          branch: "feature/rigd",
        })

        const rigd = yield* V2Rigd
        return yield* rigd.inventory({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          config,
        })
      }),
    )

    expect(inventory.project).toBe("pantry")
    expect(inventory.deployments.map((deployment) => `${deployment.kind}:${deployment.name}`)).toEqual([
      "local:local",
      "live:live",
      "generated:feature-rigd",
    ])
  })

  test("GIVEN lifecycle and deploy actions WHEN accepted THEN structured logs and health state are exposed", async () => {
    const { result } = await runWithRigd(
      Effect.gen(function* () {
        const rigd = yield* V2Rigd
        yield* rigd.start({ stateRoot: "/tmp/rig-v2" })
        const lifecycle = yield* rigd.lifecycle({
          action: "up",
          project: "pantry",
          lane: "local",
          stateRoot: "/tmp/rig-v2",
        })
        const deploy = yield* rigd.deploy({
          project: "pantry",
          target: "live",
          ref: "main",
          stateRoot: "/tmp/rig-v2",
        })
        const logs = yield* rigd.logs({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          lines: 10,
        })
        const healthState = yield* rigd.healthState({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
        })

        return { lifecycle, deploy, logs, healthState }
      }),
    )

    expect(result.lifecycle.accepted).toBe(true)
    expect(result.lifecycle.kind).toBe("lifecycle")
    expect(result.deploy.accepted).toBe(true)
    expect(result.deploy.kind).toBe("deploy")
    expect(result.logs.map((entry) => entry.event)).toEqual([
      "rigd.started",
      "rigd.lifecycle.accepted",
      "rigd.deploy.accepted",
    ])
    expect(result.healthState.rigd.status).toBe("running")
    expect(result.healthState.deployments).toEqual([])
  })
})
