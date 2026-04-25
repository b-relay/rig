import { describe, expect, test } from "bun:test"
import { Effect } from "effect-v4"

import {
  V2ControlPlaneTransportProvider,
  V2HealthCheckerProvider,
  V2ProcessSupervisorProvider,
  V2ProviderContractsLive,
  V2ProviderRegistry,
  V2ProviderRegistryLive,
  v2ProviderFamilies,
  type V2ProviderPlugin,
} from "./provider-contracts.js"

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
      expect(report.providers.map((provider) => provider.family).sort()).toEqual([...v2ProviderFamilies].sort())
      expect(report.providers.every((provider) => provider.source === "first-party")).toBe(true)
      expect(report.providers.every((provider) => provider.capabilities.length > 0)).toBe(true)
    }
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
    expect(report.providers.every((provider) => provider.id.startsWith("stub-"))).toBe(true)
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
      id: "isolated-e2e-process-supervisor",
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
})
