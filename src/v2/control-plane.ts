import { Context, Effect, Layer } from "effect-v4"

import type { V2PersistedRigdEvent, V2PersistedRigdReceipt } from "./rigd-state.js"

export type V2ControlPlaneExposureMode = "localhost-only" | "tailscale-dns" | "public-tunnel"
export type V2ControlPlaneAuthMode = "none" | "token-pairing"

export interface V2ControlPlaneStartInput {
  readonly exposure: V2ControlPlaneExposureMode
  readonly tailscaleDnsName?: string
}

export interface V2ControlPlaneLocalServerStatus {
  readonly status: "running" | "stopped" | "stubbed"
  readonly bindHost: "127.0.0.1"
  readonly port: number
  readonly publicPort: false
}

export interface V2ControlPlaneExposureStatus {
  readonly mode: V2ControlPlaneExposureMode
  readonly publicInternet: boolean
  readonly tailscaleDnsName?: string
  readonly tunnelUrl?: string
}

export interface V2ControlPlaneAuthStatus {
  readonly mode: V2ControlPlaneAuthMode
  readonly reason: "local-or-tailscale-network" | "public-internet-exposure"
}

export interface V2ControlPlaneStatus {
  readonly localServer: V2ControlPlaneLocalServerStatus
  readonly exposure: V2ControlPlaneExposureStatus
  readonly auth: V2ControlPlaneAuthStatus
  readonly lastHeartbeat?: string
  readonly lastTransportError?: string
  readonly lastTunnelError?: string
}

export interface V2ControlPlaneEnvelope<Type extends string, Payload> {
  readonly type: Type
  readonly version: 1
  readonly payload: Payload
}

export interface V2ControlPlaneLocalServerService {
  readonly start: () => Effect.Effect<V2ControlPlaneLocalServerStatus>
  readonly status: Effect.Effect<V2ControlPlaneLocalServerStatus>
}

export interface V2TunnelExposureResult {
  readonly status: "inactive" | "active" | "failed"
  readonly publicUrl?: string
  readonly error?: string
}

export interface V2TunnelExposureService {
  readonly expose: () => Effect.Effect<V2TunnelExposureResult>
  readonly status: Effect.Effect<V2TunnelExposureResult>
}

export interface V2ControlPlaneAuthService {
  readonly resolve: (input: V2ControlPlaneStartInput) => Effect.Effect<V2ControlPlaneAuthStatus>
}

export interface V2ControlPlaneService {
  readonly start: (input: V2ControlPlaneStartInput) => Effect.Effect<V2ControlPlaneStatus>
  readonly status: Effect.Effect<V2ControlPlaneStatus>
  readonly heartbeat: () => Effect.Effect<V2ControlPlaneStatus>
  readonly serializeEvent: (
    event: V2PersistedRigdEvent,
  ) => Effect.Effect<V2ControlPlaneEnvelope<"event", V2PersistedRigdEvent>>
  readonly serializeReceipt: (
    receipt: V2PersistedRigdReceipt,
  ) => Effect.Effect<V2ControlPlaneEnvelope<"receipt", V2PersistedRigdReceipt>>
}

export const V2ControlPlaneLocalServer =
  Context.Service<V2ControlPlaneLocalServerService>("rig/v2/V2ControlPlaneLocalServer")

export const V2TunnelExposure =
  Context.Service<V2TunnelExposureService>("rig/v2/V2TunnelExposure")

export const V2ControlPlaneAuth =
  Context.Service<V2ControlPlaneAuthService>("rig/v2/V2ControlPlaneAuth")

export const V2ControlPlane =
  Context.Service<V2ControlPlaneService>("rig/v2/V2ControlPlane")

const now = (): string => new Date().toISOString()

const stoppedStatus: V2ControlPlaneStatus = {
  localServer: {
    status: "stopped",
    bindHost: "127.0.0.1",
    port: 17373,
    publicPort: false,
  },
  exposure: {
    mode: "localhost-only",
    publicInternet: false,
  },
  auth: {
    mode: "none",
    reason: "local-or-tailscale-network",
  },
}

export const V2DefaultControlPlaneLocalServerLive = Layer.succeed(V2ControlPlaneLocalServer, {
  start: () =>
    Effect.succeed({
      status: "running",
      bindHost: "127.0.0.1",
      port: 17373,
      publicPort: false,
    }),
  status: Effect.succeed({
    status: "running",
    bindHost: "127.0.0.1",
    port: 17373,
    publicPort: false,
  }),
} satisfies V2ControlPlaneLocalServerService)

export const V2NoopTunnelExposureLive = Layer.succeed(V2TunnelExposure, {
  expose: () => Effect.succeed({ status: "inactive" }),
  status: Effect.succeed({ status: "inactive" }),
} satisfies V2TunnelExposureService)

export const V2FailingTunnelExposureLive = (error: string) =>
  Layer.succeed(V2TunnelExposure, {
    expose: () => Effect.succeed({ status: "failed", error }),
    status: Effect.succeed({ status: "failed", error }),
  } satisfies V2TunnelExposureService)

export const V2DefaultControlPlaneAuthLive = Layer.succeed(V2ControlPlaneAuth, {
  resolve: (input) =>
    Effect.succeed(
      input.exposure === "public-tunnel"
        ? {
          mode: "token-pairing",
          reason: "public-internet-exposure",
        }
        : {
          mode: "none",
          reason: "local-or-tailscale-network",
        },
    ),
} satisfies V2ControlPlaneAuthService)

const exposureStatus = (
  input: V2ControlPlaneStartInput,
  tunnel: V2TunnelExposureResult,
): V2ControlPlaneExposureStatus => ({
  mode: input.exposure,
  publicInternet: input.exposure === "public-tunnel",
  ...(input.tailscaleDnsName ? { tailscaleDnsName: input.tailscaleDnsName } : {}),
  ...(tunnel.publicUrl ? { tunnelUrl: tunnel.publicUrl } : {}),
})

export const V2ControlPlaneLive = Layer.effect(
  V2ControlPlane,
  Effect.gen(function* () {
    const localServer = yield* V2ControlPlaneLocalServer
    const tunnelExposure = yield* V2TunnelExposure
    const auth = yield* V2ControlPlaneAuth
    let current = stoppedStatus

    const buildStatus = (
      input: V2ControlPlaneStartInput,
      local: V2ControlPlaneLocalServerStatus,
      tunnel: V2TunnelExposureResult,
    ): Effect.Effect<V2ControlPlaneStatus> =>
      Effect.gen(function* () {
        const authStatus = yield* auth.resolve(input)
        return {
          localServer: local,
          exposure: exposureStatus(input, tunnel),
          auth: authStatus,
          lastHeartbeat: now(),
          ...(tunnel.status === "failed" && tunnel.error ? { lastTunnelError: tunnel.error } : {}),
        }
      })

    return {
      start: (input) =>
        Effect.gen(function* () {
          const local = yield* localServer.start()
          const tunnel = input.exposure === "public-tunnel"
            ? yield* tunnelExposure.expose()
            : yield* tunnelExposure.status
          current = yield* buildStatus(input, local, tunnel)
          return current
        }),
      status: Effect.sync(() => current),
      heartbeat: () =>
        Effect.sync(() => {
          current = {
            ...current,
            lastHeartbeat: now(),
          }
          return current
        }),
      serializeEvent: (event) =>
        Effect.succeed({
          type: "event",
          version: 1,
          payload: event,
        }),
      serializeReceipt: (receipt) =>
        Effect.succeed({
          type: "receipt",
          version: 1,
          payload: receipt,
        }),
    } satisfies V2ControlPlaneService
  }),
)

export const V2DefaultControlPlaneLive = Layer.provide(
  V2ControlPlaneLive,
  Layer.mergeAll(
    V2DefaultControlPlaneLocalServerLive,
    V2DefaultControlPlaneAuthLive,
    V2NoopTunnelExposureLive,
  ),
)

export const V2StubControlPlaneLive = Layer.succeed(V2ControlPlane, {
  start: (input) =>
    Effect.succeed({
      localServer: {
        status: "stubbed",
        bindHost: "127.0.0.1",
        port: 17373,
        publicPort: false,
      },
      exposure: {
        mode: input.exposure,
        publicInternet: input.exposure === "public-tunnel",
        ...(input.tailscaleDnsName ? { tailscaleDnsName: input.tailscaleDnsName } : {}),
      },
      auth: input.exposure === "public-tunnel"
        ? {
          mode: "token-pairing",
          reason: "public-internet-exposure",
        }
        : {
          mode: "none",
          reason: "local-or-tailscale-network",
        },
      lastHeartbeat: "stub-heartbeat",
    }),
  status: Effect.succeed({
    ...stoppedStatus,
    localServer: {
      ...stoppedStatus.localServer,
      status: "stubbed",
    },
    lastHeartbeat: "stub-heartbeat",
  }),
  heartbeat: () =>
    Effect.succeed({
      ...stoppedStatus,
      localServer: {
        ...stoppedStatus.localServer,
        status: "stubbed",
      },
      lastHeartbeat: "stub-heartbeat",
    }),
  serializeEvent: (event) =>
    Effect.succeed({
      type: "event",
      version: 1,
      payload: event,
    }),
  serializeReceipt: (receipt) =>
    Effect.succeed({
      type: "receipt",
      version: 1,
      payload: receipt,
    }),
} satisfies V2ControlPlaneService)
