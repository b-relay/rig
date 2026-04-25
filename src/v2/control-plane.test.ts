import { describe, expect, test } from "bun:test"
import { Effect } from "effect-v4"

import {
  V2ControlPlane,
  V2ControlPlaneLive,
  V2DefaultControlPlaneAuthLive,
  V2DefaultControlPlaneLocalServerLive,
  V2FailingTunnelExposureLive,
  V2NoopTunnelExposureLive,
  V2StubControlPlaneLive,
} from "./control-plane.js"

const runWithDefaultControlPlane = <A>(effect: Effect.Effect<A, unknown, V2ControlPlane>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(V2ControlPlaneLive),
      Effect.provide(V2DefaultControlPlaneLocalServerLive),
      Effect.provide(V2DefaultControlPlaneAuthLive),
      Effect.provide(V2NoopTunnelExposureLive),
    ),
  )

describe("GIVEN localhost-first control-plane services WHEN status is requested THEN exposure and auth are explicit", () => {
  test("GIVEN localhost-only mode WHEN started THEN it binds to 127.0.0.1 without a public port", async () => {
    const status = await runWithDefaultControlPlane(
      Effect.gen(function* () {
        const controlPlane = yield* V2ControlPlane
        return yield* controlPlane.start({ exposure: "localhost-only" })
      }),
    )

    expect(status.localServer).toMatchObject({
      status: "running",
      bindHost: "127.0.0.1",
      publicPort: false,
    })
    expect(status.exposure).toMatchObject({
      mode: "localhost-only",
      publicInternet: false,
    })
    expect(status.auth).toEqual({
      mode: "none",
      reason: "local-or-tailscale-network",
    })
  })

  test("GIVEN tailscale DNS mode WHEN started THEN app auth is not required", async () => {
    const status = await runWithDefaultControlPlane(
      Effect.gen(function* () {
        const controlPlane = yield* V2ControlPlane
        return yield* controlPlane.start({
          exposure: "tailscale-dns",
          tailscaleDnsName: "rig.b-relay.ts.net",
        })
      }),
    )

    expect(status.exposure).toMatchObject({
      mode: "tailscale-dns",
      publicInternet: false,
      tailscaleDnsName: "rig.b-relay.ts.net",
    })
    expect(status.auth.mode).toBe("none")
  })

  test("GIVEN public tunnel mode WHEN tunnel fails THEN token pairing is required and tunnel error is reported", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const controlPlane = yield* V2ControlPlane
        return yield* controlPlane.start({ exposure: "public-tunnel" })
      }).pipe(
        Effect.provide(V2ControlPlaneLive),
        Effect.provide(V2DefaultControlPlaneLocalServerLive),
        Effect.provide(V2DefaultControlPlaneAuthLive),
        Effect.provide(V2FailingTunnelExposureLive("cloudflare tunnel provider is not configured")),
      ),
    )

    expect(status.exposure).toMatchObject({
      mode: "public-tunnel",
      publicInternet: true,
    })
    expect(status.auth).toEqual({
      mode: "token-pairing",
      reason: "public-internet-exposure",
    })
    expect(status.lastTunnelError).toContain("cloudflare tunnel provider is not configured")
  })

  test("GIVEN runtime events and receipts WHEN serialized THEN plain JSON envelopes are produced", async () => {
    const result = await runWithDefaultControlPlane(
      Effect.gen(function* () {
        const controlPlane = yield* V2ControlPlane
        const event = yield* controlPlane.serializeEvent({
          timestamp: "2026-04-25T00:00:00.000Z",
          event: "rigd.started",
          project: "pantry",
        })
        const receipt = yield* controlPlane.serializeReceipt({
          id: "rigd-1",
          kind: "lifecycle",
          accepted: true,
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          target: "local",
          receivedAt: "2026-04-25T00:00:01.000Z",
        })
        return { event, receipt }
      }),
    )

    expect(result.event).toEqual({
      type: "event",
      version: 1,
      payload: {
        timestamp: "2026-04-25T00:00:00.000Z",
        event: "rigd.started",
        project: "pantry",
      },
    })
    expect(result.receipt).toMatchObject({
      type: "receipt",
      version: 1,
      payload: {
        id: "rigd-1",
        kind: "lifecycle",
      },
    })
  })

  test("GIVEN stub transport WHEN started THEN tests can swap the control-plane composition", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const controlPlane = yield* V2ControlPlane
        return yield* controlPlane.start({ exposure: "localhost-only" })
      }).pipe(Effect.provide(V2StubControlPlaneLive)),
    )

    expect(status.localServer.status).toBe("stubbed")
    expect(status.exposure.mode).toBe("localhost-only")
    expect(status.lastHeartbeat).toBe("stub-heartbeat")
  })
})
