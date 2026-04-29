import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { decodeV2ProjectConfig } from "./config.js"
import {
  V2DeploymentManager,
  V2DeploymentManagerLive,
  V2DeploymentStore,
  type V2DeploymentRecord,
  type V2DeploymentStoreService,
} from "./deployments.js"

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

const fixturePath = (...parts: readonly string[]) =>
  join(process.cwd(), "fixtures", "rig2-projects", ...parts)

const loadFixtureConfig = (name: string) =>
  Effect.gen(function* () {
    const raw = yield* Effect.promise(() => readFile(fixturePath(name, "rig2.json"), "utf8"))
    return yield* decodeV2ProjectConfig(JSON.parse(raw) as unknown)
  })

const runWithDeploymentManager = <A>(effect: Effect.Effect<A, unknown, V2DeploymentManager>) => {
  const store = new MemoryDeploymentStore()
  const layer = Layer.provide(V2DeploymentManagerLive, Layer.succeed(V2DeploymentStore, store))
  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

describe("GIVEN fake rig2 project fixtures WHEN deployment inventory is resolved THEN Pantry is not the test bed", () => {
  test("GIVEN fullstack basic fixture WHEN local live and generated records are listed THEN app service database and Convex-like ports stay isolated", async () => {
    const inventory = await runWithDeploymentManager(
      Effect.gen(function* () {
        const config = yield* loadFixtureConfig("fullstack-basic")
        const manager = yield* V2DeploymentManager
        yield* manager.materializeGenerated({
          config,
          stateRoot: "/tmp/rig-v2-fixtures",
          branch: "feature/Fake Preview",
          assignedPorts: {
            postgres: 45432,
            convex: 43210,
            "convex.site": 43211,
            api: 48080,
            web: 45173,
          },
        })
        return yield* manager.list({
          config,
          stateRoot: "/tmp/rig-v2-fixtures",
        })
      }),
    )

    const local = inventory.find((record) => record.kind === "local")
    const live = inventory.find((record) => record.kind === "live")
    const generated = inventory.find((record) => record.kind === "generated")

    expect(local?.resolved.environment.services).toEqual([
      expect.objectContaining({
        name: "postgres",
        port: 55432,
        command: "sh -c 'test -f \"$1/PG_VERSION\" || initdb -D \"$1\"; exec postgres -D \"$1\" -h 127.0.0.1 -p \"$2\"' -- '/tmp/rig-v2-fixtures/data/fullstack_basic/local/postgres/postgres' 55432",
        healthCheck: "pg_isready -h 127.0.0.1 -p 55432",
      }),
      expect.objectContaining({
        name: "convex",
        port: 3210,
        command: "bunx convex dev --local --local-cloud-port 3210 --local-site-port 3211",
        healthCheck: "http://127.0.0.1:3210/instance_name",
        dependsOn: ["postgres"],
      }),
      expect.objectContaining({ name: "api", port: 8081, dependsOn: ["postgres", "convex"] }),
      expect.objectContaining({ name: "web", port: 5173, dependsOn: ["api"] }),
    ])
    expect(live?.resolved.environment.services).toEqual([
      expect.objectContaining({
        name: "postgres",
        port: 55433,
        command: "sh -c 'test -f \"$1/PG_VERSION\" || initdb -D \"$1\"; exec postgres -D \"$1\" -h 127.0.0.1 -p \"$2\"' -- '/tmp/rig-v2-fixtures/data/fullstack_basic/live/postgres/postgres' 55433",
        healthCheck: "pg_isready -h 127.0.0.1 -p 55433",
      }),
      expect.objectContaining({
        name: "convex",
        port: 3220,
        command: "bunx convex dev --local --local-cloud-port 3220 --local-site-port 3221",
        healthCheck: "http://127.0.0.1:3220/instance_name",
        dependsOn: ["postgres"],
      }),
      expect.objectContaining({ name: "api", port: 8080, dependsOn: ["postgres", "convex"] }),
      expect.objectContaining({ name: "web", port: 3070, dependsOn: ["api"] }),
    ])
    expect(generated).toMatchObject({
      name: "feature-fake-preview",
      subdomain: "feature-fake-preview",
      assignedPorts: {
        postgres: 45432,
        convex: 43210,
        "convex.site": 43211,
        api: 48080,
        web: 45173,
      },
    })
    expect(generated?.resolved.environment.services).toEqual([
      expect.objectContaining({
        name: "postgres",
        port: 45432,
        command: "sh -c 'test -f \"$1/PG_VERSION\" || initdb -D \"$1\"; exec postgres -D \"$1\" -h 127.0.0.1 -p \"$2\"' -- '/tmp/rig-v2-fixtures/data/fullstack_basic/deployments/feature-fake-preview/postgres/postgres' 45432",
        healthCheck: "pg_isready -h 127.0.0.1 -p 45432",
      }),
      expect.objectContaining({
        name: "convex",
        port: 43210,
        command: "bunx convex dev --local --local-cloud-port 43210 --local-site-port 43211",
        healthCheck: "http://127.0.0.1:43210/instance_name",
        dependsOn: ["postgres"],
      }),
      expect.objectContaining({ name: "api", port: 48080, dependsOn: ["postgres", "convex"] }),
      expect.objectContaining({ name: "web", port: 45173, dependsOn: ["api"] }),
    ])
    expect(generated?.resolved.v1Config.domain).toBe("feature-fake-preview.fixture.test")
  })

  test("GIVEN fullstack basic fixture WHEN SQLite path is interpolated THEN database files live under each deployment data root", async () => {
    const inventory = await runWithDeploymentManager(
      Effect.gen(function* () {
        const config = yield* loadFixtureConfig("fullstack-basic")
        const manager = yield* V2DeploymentManager
        yield* manager.materializeGenerated({
          config,
          stateRoot: "/tmp/rig-v2-fixtures",
          branch: "feature/Fake Preview",
          assignedPorts: {
            postgres: 45432,
            convex: 43210,
            "convex.site": 43211,
            api: 48080,
            web: 45173,
          },
        })
        return yield* manager.list({
          config,
          stateRoot: "/tmp/rig-v2-fixtures",
        })
      }),
    )

    const local = inventory.find((record) => record.kind === "local")
    const live = inventory.find((record) => record.kind === "live")
    const generated = inventory.find((record) => record.kind === "generated")

    expect(local?.dataRoot).toBe("/tmp/rig-v2-fixtures/data/fullstack_basic/local")
    expect(live?.dataRoot).toBe("/tmp/rig-v2-fixtures/data/fullstack_basic/live")
    expect(generated?.dataRoot).toBe("/tmp/rig-v2-fixtures/data/fullstack_basic/deployments/feature-fake-preview")
    expect(local?.resolved.preparedComponents).toContainEqual({
      name: "db",
      uses: "sqlite",
      path: "/tmp/rig-v2-fixtures/data/fullstack_basic/local/sqlite/db.sqlite",
    })
    expect(live?.resolved.preparedComponents).toContainEqual({
      name: "db",
      uses: "sqlite",
      path: "/tmp/rig-v2-fixtures/data/fullstack_basic/live/sqlite/db.sqlite",
    })
    expect(generated?.resolved.preparedComponents).toContainEqual({
      name: "db",
      uses: "sqlite",
      path: "/tmp/rig-v2-fixtures/data/fullstack_basic/deployments/feature-fake-preview/sqlite/db.sqlite",
    })
    expect(local?.resolved.preparedComponents).toContainEqual({
      name: "postgres",
      uses: "postgres",
      dataDir: "/tmp/rig-v2-fixtures/data/fullstack_basic/local/postgres/postgres",
    })
    expect(live?.resolved.preparedComponents).toContainEqual({
      name: "postgres",
      uses: "postgres",
      dataDir: "/tmp/rig-v2-fixtures/data/fullstack_basic/live/postgres/postgres",
    })
    expect(generated?.resolved.preparedComponents).toContainEqual({
      name: "postgres",
      uses: "postgres",
      dataDir: "/tmp/rig-v2-fixtures/data/fullstack_basic/deployments/feature-fake-preview/postgres/postgres",
    })
    expect(local?.resolved.preparedComponents).toContainEqual({
      name: "convex",
      uses: "convex",
      stateDir: "/tmp/rig-v2-fixtures/workspaces/fullstack_basic/local/.convex/local/default",
    })
    expect(live?.resolved.preparedComponents).toContainEqual({
      name: "convex",
      uses: "convex",
      stateDir: "/tmp/rig-v2-fixtures/workspaces/fullstack_basic/live/.convex/local/default",
    })
    expect(generated?.resolved.preparedComponents).toContainEqual({
      name: "convex",
      uses: "convex",
      stateDir: "/tmp/rig-v2-fixtures/workspaces/fullstack_basic/deployments/feature-fake-preview/.convex/local/default",
    })
    expect(local?.resolved.environment.services).toContainEqual(expect.objectContaining({
      name: "api",
      command: "bun --watch run api -- --host 127.0.0.1 --port 8081 --sqlite /tmp/rig-v2-fixtures/data/fullstack_basic/local/sqlite/db.sqlite",
    }))
    expect(live?.resolved.environment.services).toContainEqual(expect.objectContaining({
      name: "api",
      command: "bun run api -- --host 127.0.0.1 --port 8080 --sqlite /tmp/rig-v2-fixtures/data/fullstack_basic/live/sqlite/db.sqlite",
    }))
    expect(generated?.resolved.environment.services).toContainEqual(expect.objectContaining({
      name: "api",
      command: "bun run api -- --host 127.0.0.1 --port 48080 --sqlite /tmp/rig-v2-fixtures/data/fullstack_basic/deployments/feature-fake-preview/sqlite/db.sqlite",
    }))
  })
})
