import { Context, Effect, Layer } from "effect"

import type { RigPersistedRigdEvent, RigPersistedRigdReceipt } from "./rigd-state.js"

export type RigControlPlaneExposureMode = "localhost-only" | "tailscale-dns" | "public-tunnel"
export type RigControlPlaneAuthMode = "none" | "token-pairing"

export interface RigControlPlaneStartInput {
  readonly exposure: RigControlPlaneExposureMode
  readonly tailscaleDnsName?: string
  readonly hosted?: RigHostedControlPlaneStartInput
}

export interface RigControlPlaneLocalServerStatus {
  readonly status: "running" | "stopped" | "stubbed"
  readonly bindHost: "127.0.0.1"
  readonly port: number
  readonly publicPort: false
}

export interface RigControlPlaneExposureStatus {
  readonly mode: RigControlPlaneExposureMode
  readonly publicInternet: boolean
  readonly tailscaleDnsName?: string
  readonly tunnelUrl?: string
}

export interface RigControlPlaneAuthStatus {
  readonly mode: RigControlPlaneAuthMode
  readonly reason: "local-or-tailscale-network" | "public-internet-exposure"
}

export interface RigControlPlaneStatus {
  readonly localServer: RigControlPlaneLocalServerStatus
  readonly exposure: RigControlPlaneExposureStatus
  readonly auth: RigControlPlaneAuthStatus
  readonly hostedTransport?: RigHostedControlPlaneTransportStatus
  readonly lastHeartbeat?: string
  readonly lastTransportError?: string
  readonly lastTransportFailure?: RigControlPlaneTransportFailure
  readonly lastTunnelError?: string
}

export interface RigControlPlaneEnvelope<Type extends string, Payload> {
  readonly type: Type
  readonly version: 1
  readonly payload: Payload
}

export interface RigHostedControlPlaneStartInput {
  readonly endpoint: string
  readonly machineId: string
  readonly pairingToken?: string
}

export type RigHostedControlPlaneTransportStatus =
  | {
    readonly status: "disabled"
  }
  | {
    readonly status: "connected" | "sent"
    readonly endpoint: string
    readonly machineId: string
    readonly paired: boolean
  }
  | {
    readonly status: "failed"
    readonly endpoint: string
    readonly machineId: string
    readonly paired: false
    readonly error: string
  }

export interface RigControlPlaneTransportFailure {
  readonly providerId: "hosted-control-plane"
  readonly operation: "connect" | "send"
  readonly endpoint: string
  readonly machineId: string
  readonly error: string
  readonly attempts: number
  readonly observedAt: string
  readonly envelopeType?: string
}

export interface RigHostedControlPlaneConnectInput extends RigHostedControlPlaneStartInput {
  readonly publicInternet: boolean
  readonly tunnelUrl?: string
}

export interface RigHostedControlPlaneSendInput {
  readonly endpoint: string
  readonly machineId: string
  readonly envelope: RigControlPlaneEnvelope<string, unknown>
}

export interface RigControlPlaneLocalServerService {
  readonly start: () => Effect.Effect<RigControlPlaneLocalServerStatus>
  readonly status: Effect.Effect<RigControlPlaneLocalServerStatus>
}

export interface RigTunnelExposureResult {
  readonly status: "inactive" | "active" | "failed"
  readonly publicUrl?: string
  readonly error?: string
}

export interface RigTunnelExposureService {
  readonly expose: () => Effect.Effect<RigTunnelExposureResult>
  readonly status: Effect.Effect<RigTunnelExposureResult>
}

export interface RigControlPlaneAuthService {
  readonly resolve: (input: RigControlPlaneStartInput) => Effect.Effect<RigControlPlaneAuthStatus>
}

export interface RigHostedControlPlaneTransportService {
  readonly connect: (
    input: RigHostedControlPlaneConnectInput,
  ) => Effect.Effect<RigHostedControlPlaneTransportStatus>
  readonly send: (
    input: RigHostedControlPlaneSendInput,
  ) => Effect.Effect<RigHostedControlPlaneTransportStatus>
}

export interface RigControlPlaneService {
  readonly start: (input: RigControlPlaneStartInput) => Effect.Effect<RigControlPlaneStatus>
  readonly status: Effect.Effect<RigControlPlaneStatus>
  readonly heartbeat: () => Effect.Effect<RigControlPlaneStatus>
  readonly serializeEvent: (
    event: RigPersistedRigdEvent,
  ) => Effect.Effect<RigControlPlaneEnvelope<"event", RigPersistedRigdEvent>>
  readonly serializeReceipt: (
    receipt: RigPersistedRigdReceipt,
  ) => Effect.Effect<RigControlPlaneEnvelope<"receipt", RigPersistedRigdReceipt>>
  readonly serializeReadModel: <Payload>(
    model: Payload,
  ) => Effect.Effect<RigControlPlaneEnvelope<"read-model", Payload>>
  readonly sendEnvelope: (
    envelope: RigControlPlaneEnvelope<string, unknown>,
  ) => Effect.Effect<RigHostedControlPlaneTransportStatus>
}

export const RigControlPlaneLocalServer =
  Context.Service<RigControlPlaneLocalServerService>("rig/rig/RigControlPlaneLocalServer")

export const RigTunnelExposure =
  Context.Service<RigTunnelExposureService>("rig/rig/RigTunnelExposure")

export const RigControlPlaneAuth =
  Context.Service<RigControlPlaneAuthService>("rig/rig/RigControlPlaneAuth")

export const RigHostedControlPlaneTransport =
  Context.Service<RigHostedControlPlaneTransportService>("rig/rig/RigHostedControlPlaneTransport")

export const RigControlPlane =
  Context.Service<RigControlPlaneService>("rig/rig/RigControlPlane")

const now = (): string => new Date().toISOString()

const stoppedStatus: RigControlPlaneStatus = {
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

export const RigDefaultControlPlaneLocalServerLive = Layer.succeed(RigControlPlaneLocalServer, {
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
} satisfies RigControlPlaneLocalServerService)

export const RigNoopTunnelExposureLive = Layer.succeed(RigTunnelExposure, {
  expose: () => Effect.succeed({ status: "inactive" }),
  status: Effect.succeed({ status: "inactive" }),
} satisfies RigTunnelExposureService)

export const RigFailingTunnelExposureLive = (error: string) =>
  Layer.succeed(RigTunnelExposure, {
    expose: () => Effect.succeed({ status: "failed", error }),
    status: Effect.succeed({ status: "failed", error }),
  } satisfies RigTunnelExposureService)

export const RigDefaultControlPlaneAuthLive = Layer.succeed(RigControlPlaneAuth, {
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
} satisfies RigControlPlaneAuthService)

export const RigDisabledHostedControlPlaneTransportLive = Layer.succeed(RigHostedControlPlaneTransport, {
  connect: () => Effect.succeed({ status: "disabled" }),
  send: () => Effect.succeed({ status: "disabled" }),
} satisfies RigHostedControlPlaneTransportService)

const exposureStatus = (
  input: RigControlPlaneStartInput,
  tunnel: RigTunnelExposureResult,
): RigControlPlaneExposureStatus => ({
  mode: input.exposure,
  publicInternet: input.exposure === "public-tunnel",
  ...(input.tailscaleDnsName ? { tailscaleDnsName: input.tailscaleDnsName } : {}),
  ...(tunnel.publicUrl ? { tunnelUrl: tunnel.publicUrl } : {}),
})

const transportFailure = (
  operation: RigControlPlaneTransportFailure["operation"],
  status: Extract<RigHostedControlPlaneTransportStatus, { readonly status: "failed" }>,
  attempts: number,
  envelopeType?: string,
): RigControlPlaneTransportFailure => ({
  providerId: "hosted-control-plane",
  operation,
  endpoint: status.endpoint,
  machineId: status.machineId,
  error: status.error,
  attempts,
  observedAt: now(),
  ...(envelopeType ? { envelopeType } : {}),
})

const clearTransportFailure = (status: RigControlPlaneStatus): RigControlPlaneStatus => {
  const {
    lastTransportError: _lastTransportError,
    lastTransportFailure: _lastTransportFailure,
    ...rest
  } = status
  return rest
}

export const RigControlPlaneLive = Layer.effect(
  RigControlPlane,
  Effect.gen(function* () {
    const localServer = yield* RigControlPlaneLocalServer
    const tunnelExposure = yield* RigTunnelExposure
    const auth = yield* RigControlPlaneAuth
    const hostedTransport = yield* RigHostedControlPlaneTransport
    let current = stoppedStatus
    let currentHosted: RigHostedControlPlaneStartInput | undefined
    let currentStartInput: RigControlPlaneStartInput | undefined

    const connectHostedTransport = (
      input: RigHostedControlPlaneConnectInput,
      maxAttempts: number,
    ): Effect.Effect<{
      readonly status: RigHostedControlPlaneTransportStatus
      readonly failure?: RigControlPlaneTransportFailure
    }> =>
      Effect.gen(function* () {
        let lastFailure: Extract<RigHostedControlPlaneTransportStatus, { readonly status: "failed" }> | undefined
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const status = yield* hostedTransport.connect(input)
          if (status.status !== "failed") {
            return { status }
          }
          lastFailure = status
        }

        const status = lastFailure ?? {
          status: "failed" as const,
          endpoint: input.endpoint,
          machineId: input.machineId,
          paired: false,
          error: "Hosted control-plane connect failed without provider details.",
        }
        return {
          status,
          failure: transportFailure("connect", status, maxAttempts),
        }
      })

    const sendHostedEnvelope = (
      input: RigHostedControlPlaneSendInput,
      maxAttempts: number,
    ): Effect.Effect<RigHostedControlPlaneTransportStatus> =>
      Effect.gen(function* () {
        let lastFailure: Extract<RigHostedControlPlaneTransportStatus, { readonly status: "failed" }> | undefined
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const status = yield* hostedTransport.send(input)
          if (status.status !== "failed") {
            current = clearTransportFailure({
              ...current,
              hostedTransport: status,
              lastHeartbeat: now(),
            })
            return status
          }
          lastFailure = status
        }

        const status = lastFailure ?? {
          status: "failed" as const,
          endpoint: input.endpoint,
          machineId: input.machineId,
          paired: false,
          error: "Hosted control-plane send failed without provider details.",
        }
        const failure = transportFailure("send", status, maxAttempts, input.envelope.type)
        current = {
          ...current,
          hostedTransport: status,
          lastTransportError: status.error,
          lastTransportFailure: failure,
          lastHeartbeat: now(),
        }
        return status
      })

    const buildStatus = (
      input: RigControlPlaneStartInput,
      local: RigControlPlaneLocalServerStatus,
      tunnel: RigTunnelExposureResult,
    ): Effect.Effect<RigControlPlaneStatus> =>
      Effect.gen(function* () {
        const authStatus = yield* auth.resolve(input)
        const hostedResult = yield* resolveHostedTransport(input, authStatus, exposureStatus(input, tunnel), 2)
        const base = {
          localServer: local,
          exposure: exposureStatus(input, tunnel),
          auth: authStatus,
          ...(hostedResult?.status ? { hostedTransport: hostedResult.status } : {}),
          lastHeartbeat: now(),
          ...(hostedResult?.failure
            ? {
              lastTransportError: hostedResult.failure.error,
              lastTransportFailure: hostedResult.failure,
            }
            : {}),
          ...(tunnel.status === "failed" && tunnel.error ? { lastTunnelError: tunnel.error } : {}),
        }
        return hostedResult?.failure ? base : clearTransportFailure(base)
      })

    const resolveHostedTransport = (
      input: RigControlPlaneStartInput,
      authStatus: RigControlPlaneAuthStatus,
      exposure: RigControlPlaneExposureStatus,
      maxAttempts: number,
    ): Effect.Effect<{
      readonly status: RigHostedControlPlaneTransportStatus
      readonly failure?: RigControlPlaneTransportFailure
    } | undefined> => {
      if (!input.hosted) {
        currentHosted = undefined
        currentStartInput = undefined
        return Effect.succeed(undefined)
      }

      if (authStatus.mode === "token-pairing" && !input.hosted.pairingToken) {
        currentHosted = undefined
        currentStartInput = undefined
        const status = {
          status: "failed",
          endpoint: input.hosted.endpoint,
          machineId: input.hosted.machineId,
          paired: false,
          error: "Hosted public control-plane transport requires a pairing token.",
        } as const
        return Effect.succeed({
          status,
          failure: transportFailure("connect", status, 0),
        })
      }

      return Effect.gen(function* () {
        currentStartInput = input
        const transportResult = yield* connectHostedTransport({
          ...input.hosted,
          publicInternet: exposure.publicInternet,
          ...(exposure.tunnelUrl ? { tunnelUrl: exposure.tunnelUrl } : {}),
        }, maxAttempts)
        const transportStatus = transportResult.status
        currentHosted = transportStatus.status === "connected" || transportStatus.status === "sent"
          ? input.hosted
          : undefined
        return transportResult
      })
    }

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
        Effect.gen(function* () {
          if (currentStartInput?.hosted) {
            const authStatus = yield* auth.resolve(currentStartInput)
            const hostedResult = yield* resolveHostedTransport(
              currentStartInput,
              authStatus,
              current.exposure,
              1,
            )
            current = hostedResult?.failure
              ? {
                ...current,
                auth: authStatus,
                hostedTransport: hostedResult.status,
                lastHeartbeat: now(),
                lastTransportError: hostedResult.failure.error,
                lastTransportFailure: hostedResult.failure,
              }
              : clearTransportFailure({
                ...current,
                auth: authStatus,
                ...(hostedResult?.status ? { hostedTransport: hostedResult.status } : {}),
                lastHeartbeat: now(),
              })
            return current
          }

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
      serializeReadModel: (model) =>
        Effect.succeed({
          type: "read-model",
          version: 1,
          payload: model,
        }),
      sendEnvelope: (envelope) =>
        currentHosted
          ? sendHostedEnvelope({
            endpoint: currentHosted.endpoint,
            machineId: currentHosted.machineId,
            envelope,
          }, 2)
          : Effect.succeed({ status: "disabled" }),
    } satisfies RigControlPlaneService
  }),
)

export const RigDefaultControlPlaneLive = Layer.provide(
  RigControlPlaneLive,
  Layer.mergeAll(
    RigDefaultControlPlaneLocalServerLive,
    RigDefaultControlPlaneAuthLive,
    RigNoopTunnelExposureLive,
    RigDisabledHostedControlPlaneTransportLive,
  ),
)

export const RigStubControlPlaneLive = Layer.succeed(RigControlPlane, {
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
  serializeReadModel: (model) =>
    Effect.succeed({
      type: "read-model",
      version: 1,
      payload: model,
    }),
  sendEnvelope: () => Effect.succeed({ status: "disabled" }),
} satisfies RigControlPlaneService)
