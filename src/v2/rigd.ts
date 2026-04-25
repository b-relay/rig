import { Context, Effect, Layer } from "effect-v4"

import type { V2ProjectConfig } from "./config.js"
import { V2DeploymentManager, type V2DeploymentRecord } from "./deployments.js"
import { V2RuntimeError } from "./errors.js"
import type { V2LifecycleAction, V2LifecycleLane } from "./lifecycle.js"
import { V2ProviderRegistry, type V2ProviderRegistryReport } from "./provider-contracts.js"
import { V2RigdStateStore, type V2DeploymentSnapshot, type V2PortReservation } from "./rigd-state.js"
import { V2Logger, V2Runtime, type V2FoundationState } from "./services.js"

export interface V2ControlPlaneContract {
  readonly website: "https://rig.b-relay.com"
  readonly transport: "localhost-http"
  readonly bindHost: "127.0.0.1"
  readonly exposure: "localhost-first"
  readonly remoteAccess: readonly ["tailscale-dns", "cloudflare-tunnel-plugin"]
  readonly auth: {
    readonly tailscale: "not-required"
    readonly publicInternet: "token-pairing"
  }
  readonly status: "documented-localhost-first"
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
  readonly providers: V2ProviderRegistryReport
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
  website: "https://rig.b-relay.com",
  transport: "localhost-http",
  bindHost: "127.0.0.1",
  exposure: "localhost-first",
  remoteAccess: ["tailscale-dns", "cloudflare-tunnel-plugin"],
  auth: {
    tailscale: "not-required",
    publicInternet: "token-pairing",
  },
  status: "documented-localhost-first",
}

const now = (): string => new Date().toISOString()

export const V2RigdLive = Layer.effect(
  V2Rigd,
  Effect.gen(function* () {
    const runtime = yield* V2Runtime
    const deployments = yield* V2DeploymentManager
    const logger = yield* V2Logger
    const providerRegistry = yield* V2ProviderRegistry
    const stateStore = yield* V2RigdStateStore
    const startedAt = now()
    const events: V2RigdLogEntry[] = []

    const health = (stateRoot: string): Effect.Effect<V2RigdHealth> =>
      Effect.gen(function* () {
        const providers = yield* providerRegistry.current
        const current = {
          service: "rigd",
          status: "running",
          stateRoot,
          startedAt,
          localApi: {
            transport: "in-process",
            version: "v2-mvp",
          },
          controlPlane: controlPlaneContract,
          providers,
        } satisfies V2RigdHealth

        yield* stateStore.writeHealthSummary({
          stateRoot,
          summary: {
            service: "rigd",
            status: "running",
            checkedAt: now(),
            providerProfile: providers.profile,
          },
        })
        yield* stateStore.writeProviderObservations({
          stateRoot,
          observations: providers.providers.map((provider) => ({
            id: provider.id,
            family: provider.family,
            status: "confirmed" as const,
            observedAt: now(),
            capabilities: provider.capabilities,
          })),
        })

        return current
      })

    const persistInventoryEvidence = (
      stateRoot: string,
      deploymentInventory: readonly V2DeploymentRecord[],
    ): Effect.Effect<void, V2RuntimeError> =>
      Effect.gen(function* () {
        const observedAt = now()
        const snapshots: readonly V2DeploymentSnapshot[] = deploymentInventory.map((deployment) => ({
          project: deployment.project,
          deployment: deployment.name,
          kind: deployment.kind,
          observedAt,
          providerProfile: deployment.providerProfile,
        }))
        const reservations: readonly V2PortReservation[] = deploymentInventory.flatMap((deployment) =>
          Object.entries(deployment.assignedPorts).map(([component, port]) => ({
            project: deployment.project,
            deployment: deployment.name,
            component,
            port,
            owner: "rigd" as const,
            status: "reserved" as const,
            observedAt,
          })),
        )

        yield* stateStore.writeDeploymentSnapshot({
          stateRoot,
          snapshots,
        })
        yield* stateStore.writePortReservations({
          stateRoot,
          reservations,
        })
      })

    const appendEvent = (
      stateRoot: string,
      entry: Omit<V2RigdLogEntry, "timestamp">,
    ): Effect.Effect<void, V2RuntimeError> =>
      Effect.gen(function* () {
        const event = {
          timestamp: now(),
          ...entry,
        }
        events.push(event)
        yield* stateStore.appendEvent({
          stateRoot,
          event,
        })
      })

    const receipt = (
      kind: V2RigdActionReceipt["kind"],
      project: string,
      stateRoot: string,
      target: string,
    ): Effect.Effect<V2RigdActionReceipt, V2RuntimeError> =>
      Effect.gen(function* () {
        const persisted = yield* stateStore.load({ stateRoot })
        const accepted = {
          id: `rigd-${persisted.receipts.length + 1}`,
          kind,
          accepted: true,
          project,
          stateRoot,
          target,
          receivedAt: now(),
        } satisfies V2RigdActionReceipt

        yield* stateStore.appendReceipt({
          stateRoot,
          receipt: accepted,
        })

        return accepted
      })

    return {
      start: (input) =>
        Effect.gen(function* () {
          yield* appendEvent(input.stateRoot, {
            event: "rigd.started",
            details: {
              stateRoot: input.stateRoot,
            },
          })
          const current = yield* health(input.stateRoot)
          yield* logger.info("rigd local API ready", current)
          return current
        }),
      health: (input) => health(input.stateRoot),
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

          if (input.config) {
            yield* persistInventoryEvidence(input.stateRoot, deploymentInventory)
          }

          return {
            project: input.project,
            foundation,
            deployments: deploymentInventory,
          }
        }),
      logs: (input) =>
        Effect.gen(function* () {
          const persisted = yield* stateStore.load({
            stateRoot: input.stateRoot,
          })
          const source = persisted.events.length > 0 ? persisted.events : events

          return source
            .filter((entry) => entry.project === undefined || entry.project === input.project)
            .slice(Math.max(0, source.length - input.lines))
        }),
      healthState: (input) =>
        Effect.gen(function* () {
          const inventory = yield* (input.config
            ? deployments.list({
              config: input.config,
              stateRoot: input.stateRoot,
            })
            : Effect.succeed([]))

          if (input.config) {
            yield* persistInventoryEvidence(input.stateRoot, inventory)
          }

          return {
            rigd: yield* health(input.stateRoot),
            deployments: inventory.map((deployment) => ({
              name: deployment.name,
              kind: deployment.kind,
              status: "unknown" as const,
            })),
          }
        }),
      lifecycle: (input) =>
        Effect.gen(function* () {
          const accepted = yield* receipt("lifecycle", input.project, input.stateRoot, input.lane)
          yield* appendEvent(input.stateRoot, {
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
        Effect.gen(function* () {
          const target =
            input.target === "generated" && input.deploymentName
              ? `${input.target}:${input.deploymentName}`
              : input.target
          const accepted = yield* receipt("deploy", input.project, input.stateRoot, target)
          yield* appendEvent(input.stateRoot, {
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
