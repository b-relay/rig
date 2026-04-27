import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect-v4"

import {
  decodeV2HomeConfig,
  V2FileHomeConfigStoreLive,
  V2HomeConfigStore,
  v2HomeConfigPath,
} from "./home-config.js"

describe("GIVEN v2 home config WHEN defaults and files are used THEN behavior is covered", () => {
  test("GIVEN empty home config WHEN decoded THEN machine defaults are explicit", async () => {
    const config = await Effect.runPromise(decodeV2HomeConfig({}))

    expect(config).toEqual({
      deploy: {
        productionBranch: "main",
        generated: {
          maxActive: 5,
          replacePolicy: "oldest",
        },
      },
      providers: {
        defaultProfile: "default",
      },
      web: {
        controlPlane: "localhost",
      },
    })
  })

  test("GIVEN missing home config file WHEN read THEN defaults are returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-home-config-"))

    try {
      const config = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* V2HomeConfigStore
          return yield* store.read({ stateRoot })
        }).pipe(Effect.provide(V2FileHomeConfigStoreLive)),
      )

      expect(config.deploy.productionBranch).toBe("main")
      expect(config.deploy.generated.maxActive).toBe(5)
      expect(v2HomeConfigPath(stateRoot)).toBe(join(stateRoot, "config.json"))
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN home config file WHEN written and read THEN normalized values persist", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-home-config-write-"))

    try {
      const config = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* V2HomeConfigStore
          yield* store.write({
            stateRoot,
            config: {
              deploy: {
                productionBranch: "stable",
                generated: {
                  maxActive: 2,
                  replacePolicy: "reject",
                },
              },
              providers: {
                defaultProfile: "stub",
              },
              web: {
                controlPlane: "disabled",
              },
            },
          })
          return yield* store.read({ stateRoot })
        }).pipe(Effect.provide(V2FileHomeConfigStoreLive)),
      )

      expect(config.deploy.productionBranch).toBe("stable")
      expect(config.deploy.generated).toEqual({
        maxActive: 2,
        replacePolicy: "reject",
      })
      expect(await readFile(v2HomeConfigPath(stateRoot), "utf8")).toContain("\"productionBranch\": \"stable\"")
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
