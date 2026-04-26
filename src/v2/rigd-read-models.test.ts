import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v4"

import { decodeV2ProjectConfig, type V2ProjectConfig } from "./config.js"
import { V2ConfigEditorLive, V2ConfigFileStoreLive } from "./config-editor.js"
import { V2DefaultControlPlaneLive, V2ControlPlane } from "./control-plane.js"
import {
  V2DeploymentManager,
  V2DeploymentManagerLive,
  V2DeploymentStore,
  type V2DeploymentRecord,
  type V2DeploymentStoreService,
} from "./deployments.js"
import { V2ProviderContractsLive } from "./provider-contracts.js"
import { V2RigdActionPreflightLive } from "./rigd-actions.js"
import { V2Rigd, V2RigdLive } from "./rigd.js"
import { V2FileRigdStateStoreLive, V2RigdStateStore } from "./rigd-state.js"
import { V2RuntimeExecutorLive } from "./runtime-executor.js"
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
  info() {
    return Effect.void
  }

  error() {
    return Effect.void
  }
}

const projectConfig = (name: string): Effect.Effect<V2ProjectConfig> =>
  decodeV2ProjectConfig({
    name,
    domain: `${name}.\${subdomain}.preview.b-relay.com`,
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

const runWithRigd = async <A>(
  effect: Effect.Effect<A, unknown, V2Rigd | V2DeploymentManager | V2RigdStateStore | V2ControlPlane>,
) => {
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
    V2ProviderContractsLive("default"),
    V2FileRigdStateStoreLive,
    V2DefaultControlPlaneLive,
    V2RigdActionPreflightLive,
    Layer.provide(V2RuntimeExecutorLive, V2ProviderContractsLive("default")),
    Layer.provide(V2ConfigEditorLive, V2ConfigFileStoreLive),
    Layer.provide(
      V2RigdLive,
      Layer.mergeAll(
        V2RuntimeLive,
        deploymentManagerLive,
        Layer.succeed(V2Logger, logger),
        V2ProviderContractsLive("default"),
        V2FileRigdStateStoreLive,
        V2DefaultControlPlaneLive,
        V2RigdActionPreflightLive,
        Layer.provide(V2RuntimeExecutorLive, V2ProviderContractsLive("default")),
        Layer.provide(V2ConfigEditorLive, V2ConfigFileStoreLive),
      ),
    ),
  )

  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

describe("GIVEN rigd web read models WHEN queried THEN persisted state is exposed as plain read-side data", () => {
  test("GIVEN empty state WHEN read model is requested THEN empty projects and stale health are returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-read-model-"))

    try {
      const model = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
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
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-read-model-"))

    try {
      const model = await runWithRigd(
        Effect.gen(function* () {
          const pantry = yield* projectConfig("pantry")
          const api = yield* projectConfig("api")
          const rigd = yield* V2Rigd
          const deployments = yield* V2DeploymentManager

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
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-read-model-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const store = yield* V2RigdStateStore
          const rigd = yield* V2Rigd
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
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-read-model-"))

    try {
      const envelope = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
          const controlPlane = yield* V2ControlPlane
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
