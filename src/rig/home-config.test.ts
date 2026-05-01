import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import {
  decodeRigHomeConfig,
  RigFileHomeConfigStoreLive,
  RigHomeConfigStore,
  rigHomeConfigPath,
} from "./home-config.js"

describe("GIVEN rig home config WHEN defaults and files are used THEN behavior is covered", () => {
  test("GIVEN empty home config WHEN decoded THEN machine defaults are explicit", async () => {
    const config = await Effect.runPromise(decodeRigHomeConfig({}))

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
        caddy: {
          extraConfig: [],
          reload: {
            mode: "manual",
          },
        },
        },
        web: {
          controlPlane: "localhost",
          hosted: {
            enabled: false,
          },
        },
      })
  })

  test("GIVEN missing home config file WHEN read THEN defaults are returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-home-config-"))

    try {
      const config = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* RigHomeConfigStore
          return yield* store.read({ stateRoot })
        }).pipe(Effect.provide(RigFileHomeConfigStoreLive)),
      )

      expect(config.deploy.productionBranch).toBe("main")
      expect(config.deploy.generated.maxActive).toBe(5)
      expect(rigHomeConfigPath(stateRoot)).toBe(join(stateRoot, "config.json"))
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN home config file WHEN written and read THEN normalized values persist", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-home-config-write-"))

    try {
      const config = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* RigHomeConfigStore
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
                caddy: {
                  caddyfile: "/usr/local/etc/Caddyfile",
                  extraConfig: ["import cloudflare", "import backend_errors"],
                  reload: {
                    mode: "manual",
                    command: "sudo launchctl kickstart -k system/com.caddyserver.caddy",
                  },
                },
              },
              web: {
                controlPlane: "disabled",
                hosted: {
                  enabled: true,
                  endpoint: "https://rig.b-relay.com",
                  machineId: "macbook-pro",
                  pairingToken: "pair-123",
                },
              },
            },
          })
          return yield* store.read({ stateRoot })
        }).pipe(Effect.provide(RigFileHomeConfigStoreLive)),
      )

      expect(config.deploy.productionBranch).toBe("stable")
      expect(config.deploy.generated).toEqual({
        maxActive: 2,
        replacePolicy: "reject",
      })
      expect(config.providers.caddy).toEqual({
        caddyfile: "/usr/local/etc/Caddyfile",
        extraConfig: ["import cloudflare", "import backend_errors"],
        reload: {
          mode: "manual",
          command: "sudo launchctl kickstart -k system/com.caddyserver.caddy",
        },
      })
      expect(config.web.hosted).toEqual({
        enabled: true,
        endpoint: "https://rig.b-relay.com",
        machineId: "macbook-pro",
        pairingToken: "pair-123",
      })
      expect(await readFile(rigHomeConfigPath(stateRoot), "utf8")).toContain("\"productionBranch\": \"stable\"")
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
