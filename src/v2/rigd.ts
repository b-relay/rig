import { Context, Effect, Layer } from "effect-v4"

import type { V2ProjectConfig } from "./config.js"
import { V2DeploymentManager, type V2DeploymentRecord } from "./deployments.js"
import { V2RuntimeError } from "./errors.js"
import type { V2LifecycleAction, V2LifecycleLane } from "./lifecycle.js"
import { V2Logger, V2Runtime, type V2FoundationState } from "./services.js"

export interface V2ControlPlaneContract {
  readonly endpoint: "https://core.b-relay.com"
  readonly transport: "outbound-websocket"
  readonly outboundOnly: true
  readonly auth: "machine-token"
  readonly status: "documented-not-connected"
}

export interface V2RigdHealth {
  readonly service: "rigd"
  readonly status: "running"
  readonly stateRoot: string
  readonly startedAt: string
  readonly localApi: {
    readonly transport: "in-process"
    readonly version: "v2-mvp"
  }
  readonly controlPlane: V2ControlPlaneContract
}

export interface V2RigdStartInput {
  readonly stateRoot: string
}

export interface V2RigdProjectInventoryInput {
  readonly project: string
  readonly stateRoot: string
  readonly config?: V2ProjectConfig
}

export interface V2RigdInventory {
  readonly project: string
  readonly foundation: V2FoundationState
  readonly deployments: readonly V2DeploymentRecord[]
}

export interface V2RigdLogInput {
  readonly project: string
  readonly stateRoot: string
  readonly lines: number
}

export interface V2RigdLogEntry {
  readonly timestamp: string
  readonly event: string
  readonly project?: string
  readonly lane?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2RigdHealthStateInput {
  readonly project: string
  readonly stateRoot: string
  readonly config?: V2ProjectConfig
}

export interface V2RigdHealthState {
  readonly rigd: V2RigdHealth
  readonly deployments: readonly {
    readonly name: string
    readonly kind: V2DeploymentRecord["kind"]
    readonly status: "unknown"
  }[]
}

export interface V2RigdLifecycleInput {
  readonly action: V2LifecycleAction
  readonly project: string
  readonly lane: V2LifecycleLane
  readonly stateRoot: string
}

export interface V2RigdDeployInput {
  readonly project: string
  readonly target: "live" | "generated"
  readonly ref: string
  readonly stateRoot: string
  readonly deploymentName?: string
}

export interface V2RigdActionReceipt {
  readonly id: string
  readonly kind: "lifecycle" | "deploy"
  readonly accepted: true
  readonly project: string
  readonly stateRoot: string
  readonly target: string
  readonly receivedAt: string
}

export interface V2RigdService {
  readonly start: (input: V2RigdStartInput) => Effect.Effect<V2RigdHealth, V2RuntimeError>
  readonly health: (input: V2RigdStartInput) => Effect.Effect<V2RigdHealth, V2RuntimeError>
  readonly inventory: (input: V2RigdProjectInventoryInput) => Effect.Effect<V2RigdInventory, V2RuntimeError>
  readonly logs: (input: V2RigdLogInput) => Effect.Effect<readonly V2RigdLogEntry[], V2RuntimeError>
  readonly healthState: (input: V2RigdHealthStateInput) => Effect.Effect<V2RigdHealthState, V2RuntimeError>
  readonly lifecycle: (input: V2RigdLifecycleInput) => Effect.Effect<V2RigdActionReceipt, V2RuntimeError>
  readonly deploy: (input: V2RigdDeployInput) => Effect.Effect<V2RigdActionReceipt, V2RuntimeError>
}

export const V2Rigd = Context.Service<V2RigdService>("rig/v2/V2Rigd")

const controlPlaneContract: V2ControlPlaneContract = {
  endpoint: "https://core.b-relay.com",
  transport: "outbound-websocket",
  outboundOnly: true,
  auth: "machine-token",
  status: "documented-not-connected",
}

const now = (): string => new Date().toISOString()

export const V2RigdLive = Layer.effect(
  V2Rigd,
  Effect.gen(function* () {
    const runtime = yield* V2Runtime
    const deployments = yield* V2DeploymentManager
    const logger = yield* V2Logger
    const startedAt = now()
    const events: V2RigdLogEntry[] = []
    let sequence = 0

    const health = (stateRoot: string): V2RigdHealth => ({
      service: "rigd",
      status: "running",
      stateRoot,
      startedAt,
      localApi: {
        transport: "in-process",
        version: "v2-mvp",
      },
      controlPlane: controlPlaneContract,
    })

    const appendEvent = (entry: Omit<V2RigdLogEntry, "timestamp">) => {
      events.push({
        timestamp: now(),
        ...entry,
      })
    }

    const receipt = (
      kind: V2RigdActionReceipt["kind"],
      project: string,
      stateRoot: string,
      target: string,
    ): V2RigdActionReceipt => {
      sequence += 1
      return {
        id: `rigd-${sequence}`,
        kind,
        accepted: true,
        project,
        stateRoot,
        target,
        receivedAt: now(),
      }
    }

    return {
      start: (input) =>
        Effect.gen(function* () {
          appendEvent({
            event: "rigd.started",
            details: {
              stateRoot: input.stateRoot,
            },
          })
          const current = health(input.stateRoot)
          yield* logger.info("rigd local API ready", current)
          return current
        }),
      health: (input) => Effect.succeed(health(input.stateRoot)),
      inventory: (input) =>
        Effect.gen(function* () {
          const foundation = yield* runtime.describeFoundation({
            project: input.project,
            stateRoot: input.stateRoot,
          })
          const deploymentInventory = input.config
            ? yield* deployments.list({
              config: input.config,
              stateRoot: input.stateRoot,
            })
            : []

          return {
            project: input.project,
            foundation,
            deployments: deploymentInventory,
          }
        }),
      logs: (input) =>
        Effect.succeed(
          events
            .filter((entry) => entry.project === undefined || entry.project === input.project)
            .slice(Math.max(0, events.length - input.lines)),
        ),
      healthState: (input) =>
        Effect.gen(function* () {
          const inventory = yield* (input.config
            ? deployments.list({
              config: input.config,
              stateRoot: input.stateRoot,
            })
            : Effect.succeed([]))

          return {
            rigd: health(input.stateRoot),
            deployments: inventory.map((deployment) => ({
              name: deployment.name,
              kind: deployment.kind,
              status: "unknown" as const,
            })),
          }
        }),
      lifecycle: (input) =>
        Effect.sync(() => {
          const accepted = receipt("lifecycle", input.project, input.stateRoot, input.lane)
          appendEvent({
            event: "rigd.lifecycle.accepted",
            project: input.project,
            lane: input.lane,
            details: {
              action: input.action,
              receiptId: accepted.id,
            },
          })
          return accepted
        }),
      deploy: (input) =>
        Effect.sync(() => {
          const target =
            input.target === "generated" && input.deploymentName
              ? `${input.target}:${input.deploymentName}`
              : input.target
          const accepted = receipt("deploy", input.project, input.stateRoot, target)
          appendEvent({
            event: "rigd.deploy.accepted",
            project: input.project,
            details: {
              target: input.target,
              ref: input.ref,
              deploymentName: input.deploymentName,
              receiptId: accepted.id,
            },
          })
          return accepted
        }),
    } satisfies V2RigdService
  }),
)
