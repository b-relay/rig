import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { decodeRigProjectConfig } from "./config.js"
import {
  RigFileDeploymentStoreLive,
  RigDeploymentManager,
  RigDeploymentManagerLive,
  RigDeploymentStore,
  type RigDeploymentRecord,
  type RigDeploymentStoreService,
} from "./deployments.js"

class MemoryDeploymentStore implements RigDeploymentStoreService {
  readonly records = new Map<string, RigDeploymentRecord[]>()
  readonly ensured: RigDeploymentRecord[] = []
  readonly removed: RigDeploymentRecord[] = []

  read(project: string, _stateRoot: string) {
    return Effect.succeed(this.records.get(project) ?? [])
  }

  write(project: string, _stateRoot: string, records: readonly RigDeploymentRecord[]) {
    this.records.set(project, [...records])
    return Effect.void
  }

  ensureState(record: RigDeploymentRecord) {
    this.ensured.push(record)
    return Effect.void
  }

  removeState(record: RigDeploymentRecord) {
    this.removed.push(record)
    return Effect.void
  }
}

const runWithStore = async <A>(
  effect: Effect.Effect<A, unknown, RigDeploymentManager>,
) => {
  const store = new MemoryDeploymentStore()
  const layer = Layer.provide(RigDeploymentManagerLive, Layer.succeed(RigDeploymentStore, store))
  const result = await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { result, store }
}

const runWithFileStore = <A>(
  effect: Effect.Effect<A, unknown, RigDeploymentManager>,
): Promise<A> => {
  const layer = Layer.provide(RigDeploymentManagerLive, RigFileDeploymentStoreLive)
  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
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
      worker: {
        mode: "managed",
        command: "bun run worker -- --port ${worker.port}",
      },
      cli: {
        mode: "installed",
        entrypoint: "src/index.ts",
      },
    },
    deployments: {
      subdomain: "${branchSlug}",
      providerProfile: "stub",
    },
  })

describe("GIVEN rig generated deployments WHEN materializing inventory THEN behavior is covered", () => {
  test("GIVEN branch deployment WHEN materializing THEN isolated paths, subdomain, and assigned ports are recorded", async () => {
    const config = await Effect.runPromise(projectConfig())
    const { result: record, store } = await runWithStore(
      Effect.gen(function* () {
        const manager = yield* RigDeploymentManager
        return yield* manager.materializeGenerated({
          config,
          stateRoot: "/tmp/rig",
          branch: "Feature/Add Login",
        })
      }),
    )

    expect(record.kind).toBe("generated")
    expect(record.name).toBe("feature-add-login")
    expect(record.branchSlug).toBe("feature-add-login")
    expect(record.subdomain).toBe("feature-add-login")
    expect(record.workspacePath).toBe("/tmp/rig/workspaces/pantry/deployments/feature-add-login")
    expect(record.dataRoot).toBe("/tmp/rig/data/pantry/deployments/feature-add-login")
    expect(record.logRoot).toBe("/tmp/rig/logs/pantry/deployments/feature-add-login")
    expect(record.runtimeRoot).toBe("/tmp/rig/runtime/pantry/deployments/feature-add-login")
    expect(record.assignedPorts.web).toBeGreaterThanOrEqual(42000)
    expect(record.assignedPorts.worker).toBeGreaterThanOrEqual(42000)
    expect(record.resolved.environment.services[0]).toMatchObject({
      name: "web",
      port: record.assignedPorts.web,
      command: `bun run start -- --port ${record.assignedPorts.web}`,
      healthCheck: `http://127.0.0.1:${record.assignedPorts.web}/health`,
    })
    expect(record.resolved.v1Config.domain).toBe("feature-add-login.preview.b-relay.com")
    expect(store.ensured).toEqual([record])
    expect(store.records.get("pantry")).toEqual([record])
  })

  test("GIVEN named deployment with override WHEN materializing THEN explicit identity and subdomain are used", async () => {
    const config = await Effect.runPromise(projectConfig())
    const { result: record } = await runWithStore(
      Effect.gen(function* () {
        const manager = yield* RigDeploymentManager
        return yield* manager.materializeGenerated({
          config,
          stateRoot: "/tmp/rig",
          name: "qa-stable",
          branch: "release/2026-04",
          subdomain: "qa",
          assignedPorts: {
            web: 43100,
            worker: 43101,
          },
        })
      }),
    )

    expect(record.name).toBe("qa-stable")
    expect(record.branchSlug).toBe("release-2026-04")
    expect(record.subdomain).toBe("qa")
    expect(record.assignedPorts).toEqual({
      web: 43100,
      worker: 43101,
    })
    expect(record.resolved.v1Config.domain).toBe("qa.preview.b-relay.com")
  })

  test("GIVEN generated deployment inventory WHEN listing THEN local live and generated rows are returned consistently", async () => {
    const config = await Effect.runPromise(projectConfig())
    const { result: inventory } = await runWithStore(
      Effect.gen(function* () {
        const manager = yield* RigDeploymentManager
        yield* manager.materializeGenerated({
          config,
          stateRoot: "/tmp/rig",
          branch: "feature/a",
        })
        return yield* manager.list({
          config,
          stateRoot: "/tmp/rig",
        })
      }),
    )

    expect(inventory.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "local:local",
      "live:live",
      "generated:feature-a",
    ])
  })

  test("GIVEN generated deployment WHEN destroyed THEN only generated state is removed", async () => {
    const config = await Effect.runPromise(projectConfig())
    const { result, store } = await runWithStore(
      Effect.gen(function* () {
        const manager = yield* RigDeploymentManager
        yield* manager.materializeGenerated({
          config,
          stateRoot: "/tmp/rig",
          branch: "feature/a",
        })
        const destroyed = yield* manager.destroyGenerated({
          config,
          stateRoot: "/tmp/rig",
          name: "feature-a",
        })
        const inventory = yield* manager.list({
          config,
          stateRoot: "/tmp/rig",
        })
        return { destroyed, inventory }
      }),
    )

    expect(result.destroyed.name).toBe("feature-a")
    expect(result.inventory.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "local:local",
      "live:live",
    ])
    expect(store.removed).toEqual([result.destroyed])
  })

  test("GIVEN file-backed store WHEN materializing THEN inventory and generated state are persisted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-deployments-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const record = await runWithFileStore(
        Effect.gen(function* () {
          const manager = yield* RigDeploymentManager
          return yield* manager.materializeGenerated({
            config,
            stateRoot,
            branch: "feature/file-backed",
          })
        }),
      )

      expect(await pathExists(record.workspacePath)).toBe(true)
      expect(await pathExists(record.dataRoot)).toBe(true)
      expect(await pathExists(record.logRoot)).toBe(true)
      expect(await pathExists(record.runtimeRoot)).toBe(true)
      expect(await pathExists(record.runtimeStatePath)).toBe(true)

      const inventoryPath = join(stateRoot, "runtime", "pantry", "deployments.json")
      const rawInventory = await readFile(inventoryPath, "utf8")
      const inventory = JSON.parse(rawInventory) as RigDeploymentRecord[]
      expect(inventory.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
        "generated:feature-file-backed",
      ])

      await runWithFileStore(
        Effect.gen(function* () {
          const manager = yield* RigDeploymentManager
          return yield* manager.destroyGenerated({
            config,
            stateRoot,
            name: "feature-file-backed",
          })
        }),
      )

      expect(await pathExists(record.workspacePath)).toBe(false)
      expect(await pathExists(record.dataRoot)).toBe(false)
      expect(await pathExists(record.logRoot)).toBe(false)
      expect(await pathExists(record.runtimeRoot)).toBe(false)
      const rawAfterDestroy = await readFile(inventoryPath, "utf8")
      expect(JSON.parse(rawAfterDestroy)).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
