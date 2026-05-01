import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { decodeRigProjectConfig } from "./config.js"
import { RigConfigEditorLive, RigConfigFileStoreLive } from "./config-editor.js"
import { RigDefaultControlPlaneLive } from "./control-plane.js"
import {
  RigDeploymentManager,
  RigDeploymentManagerLive,
  RigDeploymentStore,
  type RigDeploymentRecord,
  type RigDeploymentStoreService,
} from "./deployments.js"
import { RigdActionPreflightLive } from "./rigd-actions.js"
import { Rigd, RigdLive } from "./rigd.js"
import { RigProviderContractsLive } from "./provider-contracts.js"
import { RigFileRigdStateStoreLive, RigMemoryRigdStateStoreLive, RigdStateStore } from "./rigd-state.js"
import { RigRuntimeExecutorLive } from "./runtime-executor.js"
import { RigLogger, RigRuntimeLive } from "./services.js"

class MemoryDeploymentStore implements RigDeploymentStoreService {
  readonly records = new Map<string, RigDeploymentRecord[]>()

  read(project: string, _stateRoot: string) {
    return Effect.succeed(this.records.get(project) ?? [])
  }

  write(project: string, _stateRoot: string, records: readonly RigDeploymentRecord[]) {
    this.records.set(project, [...records])
    return Effect.void
  }

  ensureState(_record: RigDeploymentRecord) {
    return Effect.void
  }

  removeState(_record: RigDeploymentRecord) {
    return Effect.void
  }
}

class CaptureRigLogger {
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
  decodeRigProjectConfig({
    name: "pantry",
    domain: "${subdomain}.preview.b-relay.com",
    components: {
      web: {
        mode: "managed",
        command: "bun run start -- --port ${web.port}",
        port: 3070,
        health: "http://127.0.0.1:${web.port}/health",
      },
    },
    deployments: {
      subdomain: "${branchSlug}",
      providerProfile: "stub",
    },
  })

const runWithRigd = async <A>(effect: Effect.Effect<A, unknown, Rigd | RigDeploymentManager>) => {
  const logger = new CaptureRigLogger()
  const deploymentStore = new MemoryDeploymentStore()
  const deploymentManagerLive = Layer.provide(
    RigDeploymentManagerLive,
    Layer.succeed(RigDeploymentStore, deploymentStore),
  )
  const layer = Layer.mergeAll(
    RigRuntimeLive,
    Layer.succeed(RigLogger, logger),
    deploymentManagerLive,
    Layer.provide(
      RigdLive,
      Layer.mergeAll(
        RigRuntimeLive,
        deploymentManagerLive,
        Layer.succeed(RigLogger, logger),
        RigProviderContractsLive("default"),
        RigMemoryRigdStateStoreLive(),
        RigDefaultControlPlaneLive,
        RigdActionPreflightLive,
        Layer.provide(RigRuntimeExecutorLive, RigProviderContractsLive("default")),
        Layer.provide(RigConfigEditorLive, RigConfigFileStoreLive),
      ),
    ),
  )
  const result = await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { result, logger, deploymentStore }
}

const runWithFileBackedRigd = async <A>(
  effect: Effect.Effect<A, unknown, Rigd | RigDeploymentManager | RigdStateStore>,
) => {
  const logger = new CaptureRigLogger()
  const deploymentStore = new MemoryDeploymentStore()
  const deploymentManagerLive = Layer.provide(
    RigDeploymentManagerLive,
    Layer.succeed(RigDeploymentStore, deploymentStore),
  )
  const layer = Layer.mergeAll(
    RigRuntimeLive,
    Layer.succeed(RigLogger, logger),
    deploymentManagerLive,
    RigProviderContractsLive("default"),
    RigFileRigdStateStoreLive,
    RigDefaultControlPlaneLive,
    RigdActionPreflightLive,
    Layer.provide(RigRuntimeExecutorLive, RigProviderContractsLive("default")),
    Layer.provide(RigConfigEditorLive, RigConfigFileStoreLive),
    Layer.provide(
      RigdLive,
      Layer.mergeAll(
        RigRuntimeLive,
        deploymentManagerLive,
        Layer.succeed(RigLogger, logger),
        RigProviderContractsLive("default"),
        RigFileRigdStateStoreLive,
        RigDefaultControlPlaneLive,
        RigdActionPreflightLive,
        Layer.provide(RigRuntimeExecutorLive, RigProviderContractsLive("default")),
        Layer.provide(RigConfigEditorLive, RigConfigFileStoreLive),
      ),
    ),
  )
  const result = await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { result, logger, deploymentStore }
}

describe("GIVEN rigd MVP local API WHEN used through its interface THEN behavior is covered", () => {
  test("GIVEN rigd start WHEN health is requested THEN local runtime authority is reported", async () => {
    const { result } = await runWithRigd(
      Effect.gen(function* () {
        const rigd = yield* Rigd
        const started = yield* rigd.start({ stateRoot: "/tmp/rig" })
        const health = yield* rigd.health({ stateRoot: "/tmp/rig" })
        return { started, health }
      }),
    )

    expect(result.started).toMatchObject({
      service: "rigd",
      status: "running",
      stateRoot: "/tmp/rig",
      localApi: {
        transport: "in-process",
        version: "rig-mvp",
      },
    })
    expect(result.health.status).toBe("running")
    expect(result.health.controlPlane.bindHost).toBe("127.0.0.1")
    expect(result.health.controlPlane.website).toBe("https://rig.b-relay.com")
    expect(result.health.controlPlane.runtime).toMatchObject({
      localServer: {
        status: "running",
        bindHost: "127.0.0.1",
        publicPort: false,
      },
      exposure: {
        mode: "localhost-only",
      },
    })
    expect(result.health.providers.profile).toBe("default")
    expect(result.health.providers.providers).toContainEqual(
      expect.objectContaining({
        id: "localhost-http",
        family: "control-plane-transport",
        capabilities: expect.arrayContaining(["127.0.0.1-bind"]),
      }),
    )
  })

  test("GIVEN materialized deployments WHEN inventory is requested THEN project and deployment inventory are exposed", async () => {
    const config = await Effect.runPromise(projectConfig())
    const { result: inventory } = await runWithRigd(
      Effect.gen(function* () {
        const deploymentManager = yield* RigDeploymentManager
        yield* deploymentManager.materializeGenerated({
          config,
          stateRoot: "/tmp/rig",
          branch: "feature/rigd",
        })

        const rigd = yield* Rigd
        return yield* rigd.inventory({
          project: "pantry",
          stateRoot: "/tmp/rig",
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
        const rigd = yield* Rigd
        yield* rigd.start({ stateRoot: "/tmp/rig" })
        const lifecycle = yield* rigd.lifecycle({
          action: "up",
          project: "pantry",
          lane: "local",
          stateRoot: "/tmp/rig",
        })
        const deploy = yield* rigd.deploy({
          project: "pantry",
          target: "live",
          ref: "main",
          stateRoot: "/tmp/rig",
        })
        const logs = yield* rigd.logs({
          project: "pantry",
          stateRoot: "/tmp/rig",
          lines: 10,
        })
        const healthState = yield* rigd.healthState({
          project: "pantry",
          stateRoot: "/tmp/rig",
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

  test("GIVEN file-backed rigd state WHEN rigd restarts THEN events receipts providers and inventory evidence are recovered", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-rigd-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      await runWithFileBackedRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          yield* rigd.start({ stateRoot })
          yield* rigd.lifecycle({
            action: "up",
            project: "pantry",
            lane: "local",
            stateRoot,
          })
          yield* rigd.deploy({
            project: "pantry",
            target: "live",
            ref: "main",
            stateRoot,
          })
          yield* rigd.inventory({
            project: "pantry",
            stateRoot,
            config,
          })
        }),
      )

      const { result } = await runWithFileBackedRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          const logs = yield* rigd.logs({
            project: "pantry",
            stateRoot,
            lines: 10,
          })
          const persisted = yield* store.reconstructMinimum({ stateRoot })
          return { logs, persisted }
        }),
      )

      expect(result.logs.map((entry) => entry.event)).toEqual([
        "rigd.started",
        "rigd.lifecycle.accepted",
        "rigd.deploy.accepted",
      ])
      expect(result.persisted.receipts.map((receipt) => `${receipt.kind}:${receipt.target}`)).toEqual([
        "lifecycle:local",
        "deploy:live",
      ])
      expect(result.persisted.providerObservations).toContainEqual(
        expect.objectContaining({
          id: "launchd",
          family: "process-supervisor",
          status: "confirmed",
        }),
      )
      expect(result.persisted.deploymentSnapshots.map((snapshot) => `${snapshot.kind}:${snapshot.deployment}`)).toEqual([
        "local:local",
        "live:live",
      ])
      expect(result.persisted.portReservations).toContainEqual(
        expect.objectContaining({
          project: "pantry",
          deployment: "local",
          component: "web",
          owner: "rigd",
          status: "reserved",
        }),
      )
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
