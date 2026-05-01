import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import {
  RigControlPlane,
  RigHostedControlPlaneTransport,
  RigControlPlaneLive,
  RigDefaultControlPlaneAuthLive,
  RigDefaultControlPlaneLocalServerLive,
  RigDisabledHostedControlPlaneTransportLive,
  RigFailingTunnelExposureLive,
  RigNoopTunnelExposureLive,
  RigStubControlPlaneLive,
  RigTunnelExposure,
} from "./control-plane.js"

const runWithDefaultControlPlane = <A>(effect: Effect.Effect<A, unknown, RigControlPlane>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(RigControlPlaneLive),
      Effect.provide(RigDefaultControlPlaneLocalServerLive),
      Effect.provide(RigDefaultControlPlaneAuthLive),
      Effect.provide(RigNoopTunnelExposureLive),
      Effect.provide(RigDisabledHostedControlPlaneTransportLive),
    ),
  )

describe("GIVEN localhost-first control-plane services WHEN status is requested THEN exposure and auth are explicit", () => {
  test("GIVEN localhost-only mode WHEN started THEN it binds to 127.0.0.1 without a public port", async () => {
    const status = await runWithDefaultControlPlane(
      Effect.gen(function* () {
        const controlPlane = yield* RigControlPlane
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
        const controlPlane = yield* RigControlPlane
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
        const controlPlane = yield* RigControlPlane
        return yield* controlPlane.start({ exposure: "public-tunnel" })
      }).pipe(
        Effect.provide(RigControlPlaneLive),
        Effect.provide(RigDefaultControlPlaneLocalServerLive),
        Effect.provide(RigDefaultControlPlaneAuthLive),
        Effect.provide(RigFailingTunnelExposureLive("cloudflare tunnel provider is not configured")),
        Effect.provide(RigDisabledHostedControlPlaneTransportLive),
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
        const controlPlane = yield* RigControlPlane
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
          stateRoot: "/tmp/rig",
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
        const controlPlane = yield* RigControlPlane
        return yield* controlPlane.start({ exposure: "localhost-only" })
      }).pipe(Effect.provide(RigStubControlPlaneLive)),
    )

    expect(status.localServer.status).toBe("stubbed")
    expect(status.exposure.mode).toBe("localhost-only")
    expect(status.lastHeartbeat).toBe("stub-heartbeat")
  })

  test("GIVEN hosted transport WHEN public tunnel is paired THEN it connects and sends envelopes through the adapter", async () => {
    const connected: unknown[] = []
    const sent: unknown[] = []
    const captureHostedTransport = Layer.succeed(RigHostedControlPlaneTransport, {
      connect: (input) =>
        Effect.sync(() => {
          connected.push(input)
          return {
            status: "connected" as const,
            endpoint: input.endpoint,
            machineId: input.machineId,
            paired: true,
          }
        }),
      send: (input) =>
        Effect.sync(() => {
          sent.push(input)
          return {
            status: "sent" as const,
            endpoint: input.endpoint,
            machineId: input.machineId,
            paired: true,
          }
        }),
    })
    const activeTunnel = Layer.succeed(RigTunnelExposure, {
      expose: () => Effect.succeed({ status: "active" as const, publicUrl: "https://preview.rig.b-relay.com" }),
      status: Effect.succeed({ status: "active" as const, publicUrl: "https://preview.rig.b-relay.com" }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const controlPlane = yield* RigControlPlane
        const status = yield* controlPlane.start({
          exposure: "public-tunnel",
          hosted: {
            endpoint: "https://rig.b-relay.com",
            machineId: "macbook-pro",
            pairingToken: "pair-123",
          },
        })
        const envelope = yield* controlPlane.serializeReadModel({ project: "pantry" })
        const send = yield* controlPlane.sendEnvelope(envelope)
        return { status, send }
      }).pipe(
        Effect.provide(RigControlPlaneLive),
        Effect.provide(RigDefaultControlPlaneLocalServerLive),
        Effect.provide(RigDefaultControlPlaneAuthLive),
        Effect.provide(activeTunnel),
        Effect.provide(captureHostedTransport),
      ),
    )

    expect(result.status.auth.mode).toBe("token-pairing")
    expect(result.status.hostedTransport).toMatchObject({
      status: "connected",
      endpoint: "https://rig.b-relay.com",
      machineId: "macbook-pro",
      paired: true,
    })
    expect(result.send).toMatchObject({
      status: "sent",
      endpoint: "https://rig.b-relay.com",
      machineId: "macbook-pro",
    })
    expect(connected).toHaveLength(1)
    expect(sent).toHaveLength(1)
  })

  test("GIVEN hosted public tunnel without a pairing token WHEN started THEN transport is blocked before connecting", async () => {
    const connected: unknown[] = []
    const captureHostedTransport = Layer.succeed(RigHostedControlPlaneTransport, {
      connect: (input) =>
        Effect.sync(() => {
          connected.push(input)
          return {
            status: "connected" as const,
            endpoint: input.endpoint,
            machineId: input.machineId,
            paired: true,
          }
        }),
      send: () => Effect.succeed({ status: "disabled" as const }),
    })
    const activeTunnel = Layer.succeed(RigTunnelExposure, {
      expose: () => Effect.succeed({ status: "active" as const, publicUrl: "https://preview.rig.b-relay.com" }),
      status: Effect.succeed({ status: "active" as const, publicUrl: "https://preview.rig.b-relay.com" }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const controlPlane = yield* RigControlPlane
        const status = yield* controlPlane.start({
          exposure: "public-tunnel",
          hosted: {
            endpoint: "https://rig.b-relay.com",
            machineId: "macbook-pro",
          },
        })
        const envelope = yield* controlPlane.serializeReadModel({ project: "pantry" })
        const send = yield* controlPlane.sendEnvelope(envelope)
        return { status, send }
      }).pipe(
        Effect.provide(RigControlPlaneLive),
        Effect.provide(RigDefaultControlPlaneLocalServerLive),
        Effect.provide(RigDefaultControlPlaneAuthLive),
        Effect.provide(activeTunnel),
        Effect.provide(captureHostedTransport),
      ),
    )

    expect(result.status.auth.mode).toBe("token-pairing")
    expect(result.status.hostedTransport).toMatchObject({
      status: "failed",
      endpoint: "https://rig.b-relay.com",
      machineId: "macbook-pro",
      paired: false,
    })
    expect(result.status.lastTransportError).toContain("pairing token")
    expect(result.send).toEqual({ status: "disabled" })
    expect(connected).toEqual([])
  })

  test("GIVEN hosted transport failures WHEN retrying and reconnecting THEN structured evidence is retained", async () => {
    let connectAttempts = 0
    let sendAttempts = 0
    const captureHostedTransport = Layer.succeed(RigHostedControlPlaneTransport, {
      connect: (input) =>
        Effect.sync(() => {
          connectAttempts += 1
          if (connectAttempts === 1 || connectAttempts === 3) {
            return {
              status: "failed" as const,
              endpoint: input.endpoint,
              machineId: input.machineId,
              paired: false,
              error: `connect failed ${connectAttempts}`,
            }
          }
          return {
            status: "connected" as const,
            endpoint: input.endpoint,
            machineId: input.machineId,
            paired: true,
          }
        }),
      send: (input) =>
        Effect.sync(() => {
          sendAttempts += 1
          return {
            status: "failed" as const,
            endpoint: input.endpoint,
            machineId: input.machineId,
            paired: false,
            error: `send failed ${sendAttempts}`,
          }
        }),
    })
    const activeTunnel = Layer.succeed(RigTunnelExposure, {
      expose: () => Effect.succeed({ status: "active" as const, publicUrl: "https://preview.rig.b-relay.com" }),
      status: Effect.succeed({ status: "active" as const, publicUrl: "https://preview.rig.b-relay.com" }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const controlPlane = yield* RigControlPlane
        const connected = yield* controlPlane.start({
          exposure: "public-tunnel",
          hosted: {
            endpoint: "https://rig.b-relay.com",
            machineId: "macbook-pro",
            pairingToken: "pair-123",
          },
        })
        const envelope = yield* controlPlane.serializeReadModel({ project: "pantry" })
        const send = yield* controlPlane.sendEnvelope(envelope)
        const afterSend = yield* controlPlane.status
        const failedReconnect = yield* controlPlane.heartbeat()
        const reconnected = yield* controlPlane.heartbeat()
        return { connected, send, afterSend, failedReconnect, reconnected }
      }).pipe(
        Effect.provide(RigControlPlaneLive),
        Effect.provide(RigDefaultControlPlaneLocalServerLive),
        Effect.provide(RigDefaultControlPlaneAuthLive),
        Effect.provide(activeTunnel),
        Effect.provide(captureHostedTransport),
      ),
    )

    expect(connectAttempts).toBe(4)
    expect(result.connected.hostedTransport).toMatchObject({
      status: "connected",
      endpoint: "https://rig.b-relay.com",
      machineId: "macbook-pro",
    })
    expect(result.send).toMatchObject({
      status: "failed",
      error: "send failed 2",
    })
    expect(result.afterSend.lastTransportFailure).toMatchObject({
      providerId: "hosted-control-plane",
      operation: "send",
      endpoint: "https://rig.b-relay.com",
      machineId: "macbook-pro",
      error: "send failed 2",
      attempts: 2,
      envelopeType: "read-model",
    })
    expect(result.failedReconnect.lastTransportFailure).toMatchObject({
      providerId: "hosted-control-plane",
      operation: "connect",
      endpoint: "https://rig.b-relay.com",
      machineId: "macbook-pro",
      error: "connect failed 3",
      attempts: 1,
    })
    expect(result.reconnected.hostedTransport).toMatchObject({
      status: "connected",
    })
  })
})
