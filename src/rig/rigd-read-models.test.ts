import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { decodeRigProjectConfig, type RigProjectConfig } from "./config.js"
import { RigConfigEditorLive, RigConfigFileStoreLive } from "./config-editor.js"
import { RigDefaultControlPlaneLive, RigControlPlane } from "./control-plane.js"
import {
  RigDeploymentManager,
  RigDeploymentManagerLive,
  RigDeploymentStore,
  type RigDeploymentRecord,
  type RigDeploymentStoreService,
} from "./deployments.js"
import { RigProviderContractsLive } from "./provider-contracts.js"
import { RigdActionPreflightLive } from "./rigd-actions.js"
import { Rigd, RigdLive } from "./rigd.js"
import { RigFileRigdStateStoreLive, RigdStateStore } from "./rigd-state.js"
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
  info() {
    return Effect.void
  }

  error() {
    return Effect.void
  }
}

const projectConfig = (name: string): Effect.Effect<RigProjectConfig> =>
  decodeRigProjectConfig({
    name,
    domain: `${name}.\${subdomain}.preview.b-relay.com`,
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

const runWithRigd = async <A>(
  effect: Effect.Effect<A, unknown, Rigd | RigDeploymentManager | RigdStateStore | RigControlPlane>,
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

  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

describe("GIVEN rigd web read models WHEN queried THEN persisted state is exposed as plain read-side data", () => {
  test("GIVEN empty state WHEN read model is requested THEN empty projects and stale health are returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-read-model-"))

    try {
      const model = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          return yield* rigd.webReadModel({ stateRoot })
        }),
      )

      expect(model.projects).toEqual([])
      expect(model.deployments).toEqual([])
      expect(model.health.rigd.status).toBe("stale")
      expect(model.health.providers).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN multiple projects and generated deployments WHEN read model is requested THEN rows are web-ready", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-read-model-"))

    try {
      const model = await runWithRigd(
        Effect.gen(function* () {
          const pantry = yield* projectConfig("pantry")
          const api = yield* projectConfig("api")
          const rigd = yield* Rigd
          const deployments = yield* RigDeploymentManager

          yield* rigd.start({ stateRoot })
          yield* deployments.materializeGenerated({
            config: pantry,
            stateRoot,
            branch: "feature/read-model",
          })
          yield* rigd.inventory({
            project: "pantry",
            stateRoot,
            config: pantry,
          })
          yield* rigd.inventory({
            project: "api",
            stateRoot,
            config: api,
          })

          return yield* rigd.webReadModel({ stateRoot })
        }),
      )

      expect(model.projects.map((project) => project.name)).toEqual(["api", "pantry"])
      expect(model.deployments.map((deployment) => `${deployment.project}:${deployment.kind}:${deployment.name}`)).toEqual([
        "api:local:local",
        "api:live:live",
        "pantry:local:local",
        "pantry:live:live",
        "pantry:generated:feature-read-model",
      ])
      expect(model.health.rigd.status).toBe("running")
      expect(model.health.providers).toContainEqual(
        expect.objectContaining({
          id: "launchd",
          family: "process-supervisor",
          status: "confirmed",
        }),
      )
      expect(model.health.components).toContainEqual(
        expect.objectContaining({
          project: "pantry",
          deployment: "local",
          component: "web",
          status: "reserved",
        }),
      )
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN structured events WHEN web logs are queried THEN project lane component and line filters apply", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-read-model-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const store = yield* RigdStateStore
          const rigd = yield* Rigd
          yield* store.appendEvent({
            stateRoot,
            event: {
              timestamp: "2026-04-25T00:00:00.000Z",
              event: "component.log",
              project: "pantry",
              lane: "local",
              component: "web",
              details: { line: "first" },
            },
          })
          yield* store.appendEvent({
            stateRoot,
            event: {
              timestamp: "2026-04-25T00:00:01.000Z",
              event: "component.log",
              project: "pantry",
              lane: "local",
              component: "web",
              details: { line: "second" },
            },
          })
          yield* store.appendEvent({
            stateRoot,
            event: {
              timestamp: "2026-04-25T00:00:02.000Z",
              event: "component.log",
              project: "pantry",
              lane: "live",
              component: "web",
              details: { line: "wrong-lane" },
            },
          })

          return yield* rigd.webLogs({
            stateRoot,
            project: "pantry",
            lane: "local",
            component: "web",
            lines: 1,
          })
        }),
      )

      expect(result.map((entry) => entry.details?.line)).toEqual(["second"])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN read model WHEN serialized through control plane THEN a plain JSON envelope is produced", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-read-model-"))

    try {
      const envelope = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const controlPlane = yield* RigControlPlane
          const model = yield* rigd.webReadModel({ stateRoot })
          return yield* controlPlane.serializeReadModel(model)
        }),
      )

      expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope)
      expect(envelope).toMatchObject({
        type: "read-model",
        version: 1,
        payload: {
          projects: [],
          deployments: [],
        },
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
