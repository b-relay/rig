import { createServer, type Server } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect-v4"

import {
  V2ControlPlaneTransportProvider,
  V2EventTransportProvider,
  V2HealthCheckerProvider,
  V2ProcessSupervisorProvider,
  V2ProviderContractsLive,
  V2ProviderRegistry,
  V2ProviderRegistryLive,
  v2ProviderFamilies,
  type V2ProviderPlugin,
} from "./provider-contracts.js"
import type { V2DeploymentRecord } from "./deployments.js"

const runWithRegistry = <A>(
  effect: Effect.Effect<A, unknown, V2ProviderRegistry>,
  profile: "default" | "stub" | "isolated-e2e",
  externalProviders: readonly V2ProviderPlugin[] = [],
) => Effect.runPromise(effect.pipe(Effect.provide(V2ProviderRegistryLive(profile, externalProviders))))

describe("GIVEN v2 provider plugin contracts WHEN registry reports profiles THEN provider composition is explicit", () => {
  test("GIVEN built-in profiles WHEN reported THEN every profile satisfies the same provider family contract", async () => {
    const reports = await Promise.all([
      runWithRegistry(Effect.gen(function* () {
        const registry = yield* V2ProviderRegistry
        return yield* registry.current
      }), "default"),
      runWithRegistry(Effect.gen(function* () {
        const registry = yield* V2ProviderRegistry
        return yield* registry.current
      }), "stub"),
      runWithRegistry(Effect.gen(function* () {
        const registry = yield* V2ProviderRegistry
        return yield* registry.current
      }), "isolated-e2e"),
    ])

    for (const report of reports) {
      expect(report.families).toEqual(v2ProviderFamilies)
      for (const family of v2ProviderFamilies) {
        expect(report.providers.some((provider) => provider.family === family)).toBe(true)
      }
      expect(report.providers.every((provider) => provider.source === "core" || provider.source === "first-party")).toBe(true)
      expect(report.providers.every((provider) => provider.capabilities.length > 0)).toBe(true)
    }

    expect(reports[0].providers).toContainEqual(expect.objectContaining({
      id: "rigd",
      family: "process-supervisor",
      source: "core",
    }))
    expect(reports[0].providers).toContainEqual(expect.objectContaining({
      id: "launchd",
      family: "process-supervisor",
      source: "first-party",
    }))
  })

  test("GIVEN an external provider WHEN registered THEN it uses the same plugin shape as bundled providers", async () => {
    const cloudflareTunnel: V2ProviderPlugin = {
      id: "cloudflare-tunnel",
      family: "tunnel",
      source: "external",
      displayName: "Cloudflare Tunnel",
      capabilities: ["public-internet", "token-pairing"],
      packageName: "@b-relay/rig-provider-cloudflare-tunnel",
    }

    const report = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* V2ProviderRegistry
        return yield* registry.current
      }),
      "default",
      [cloudflareTunnel],
    )

    expect(report.profile).toBe("default")
    expect(report.providers).toContainEqual(cloudflareTunnel)
    expect(report.providers.find((provider) => provider.id === "manual-tailscale")).toMatchObject({
      family: "tunnel",
      source: "first-party",
    })
  })

  test("GIVEN provider selection at execution boundary WHEN a different profile is requested THEN command code can swap composition", async () => {
    const report = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* V2ProviderRegistry
        return yield* registry.forProfile("stub")
      }),
      "default",
    )

    expect(report.profile).toBe("stub")
    expect(report.providers.every((provider) => provider.source === "core" || provider.id.startsWith("stub-"))).toBe(true)
    expect(report.providers.find((provider) => provider.family === "control-plane-transport")).toMatchObject({
      id: "stub-control-plane",
      capabilities: ["localhost-contract-test"],
    })
  })

  test("GIVEN provider contracts layer WHEN family services are requested THEN concrete imports are not needed", async () => {
    const selected = await Effect.runPromise(
      Effect.gen(function* () {
        const processSupervisor = yield* V2ProcessSupervisorProvider
        const controlPlane = yield* V2ControlPlaneTransportProvider
        const healthChecker = yield* V2HealthCheckerProvider

        return {
          processSupervisor: yield* processSupervisor.plugin,
          controlPlane: yield* controlPlane.plugin,
          healthChecker: yield* healthChecker.plugin,
        }
      }).pipe(Effect.provide(V2ProviderContractsLive("isolated-e2e"))),
    )

    expect(selected.processSupervisor).toMatchObject({
      id: "rigd",
      family: "process-supervisor",
    })
    expect(selected.controlPlane).toMatchObject({
      id: "localhost-http",
      family: "control-plane-transport",
    })
    expect(selected.healthChecker).toMatchObject({
      id: "native-health",
      family: "health-checker",
    })
  })

  test("GIVEN a deployment-selected process supervisor WHEN executing operations THEN bundled providers share the same interface", async () => {
    const deployment = {
      name: "live",
      workspacePath: "/tmp/rig-v2/workspaces/pantry/live",
      resolved: {
        providers: {
          processSupervisor: "launchd",
        },
      },
    } as V2DeploymentRecord

    const operation = await Effect.runPromise(
      Effect.gen(function* () {
        const processSupervisor = yield* V2ProcessSupervisorProvider
        return yield* processSupervisor.up({
          deployment,
          service: {
            name: "web",
            type: "server",
            command: "bun run start",
            port: 3070,
          },
        })
      }).pipe(Effect.provide(V2ProviderContractsLive("default"))),
    )

    expect(operation).toBe("process-supervisor:launchd:up:web")
  })

  test("GIVEN structured-log-file event transport WHEN appending THEN it writes deployment JSONL", async () => {
    const logRoot = await mkdtemp(join(tmpdir(), "rig-v2-provider-events-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        logRoot,
      } as V2DeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* V2EventTransportProvider
          return yield* events.append({
            deployment,
            event: "component.log",
            component: "web",
            details: {
              line: "started",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default"))),
      )

      const raw = await readFile(join(logRoot, "events.jsonl"), "utf8")
      const entries = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(operation).toBe("event-transport:structured-log-file:append:component.log:web")
      expect(entries).toEqual([
        expect.objectContaining({
          event: "component.log",
          project: "pantry",
          kind: "live",
          deployment: "live",
          component: "web",
          details: {
            line: "started",
          },
        }),
      ])
      expect(typeof entries[0]?.timestamp).toBe("string")
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN native-health provider WHEN HTTP check is healthy THEN it verifies the component", async () => {
    const server = await listen((_, response) => {
      response.writeHead(204)
      response.end()
    })

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
      } as V2DeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* V2HealthCheckerProvider
          return yield* health.check({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: server.port,
              healthCheck: `http://127.0.0.1:${server.port}/health`,
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default"))),
      )

      expect(operation).toBe("health-checker:native-health:check:web:healthy:204")
    } finally {
      await closeServer(server.instance)
    }
  })

  test("GIVEN native-health provider WHEN HTTP check is unhealthy THEN it returns a tagged runtime error", async () => {
    const server = await listen((_, response) => {
      response.writeHead(503)
      response.end("not ready")
    })

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
      } as V2DeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* V2HealthCheckerProvider
          return yield* health.check({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: server.port,
              healthCheck: `http://127.0.0.1:${server.port}/health`,
            },
          })
        }).pipe(
          Effect.provide(V2ProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "V2RuntimeError",
        details: {
          providerId: "native-health",
          component: "web",
          statusCode: 503,
        },
      })
    } finally {
      await closeServer(server.instance)
    }
  })
})

const listen = (handler: Parameters<typeof createServer>[0]) =>
  new Promise<{ readonly instance: Server; readonly port: number }>((resolve, reject) => {
    const instance = createServer(handler)
    instance.once("error", reject)
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address()
      if (typeof address === "object" && address !== null) {
        resolve({ instance, port: address.port })
        return
      }
      reject(new Error("HTTP test server did not expose a TCP port."))
    })
  })

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
