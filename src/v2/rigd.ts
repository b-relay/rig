import { Context, Effect, Layer } from "effect"

import type { V2ProjectConfig } from "./config.js"
import {
  V2ConfigEditor,
  type V2ConfigApplyResult,
  type V2ConfigPreviewInput,
  type V2ConfigPreviewResult,
  type V2ConfigReadInput,
  type V2ConfigReadModel,
} from "./config-editor.js"
import { V2ControlPlane, type V2ControlPlaneStatus } from "./control-plane.js"
import { branchSlug, V2DeploymentManager, type V2DeploymentRecord } from "./deployments.js"
import { V2RuntimeError } from "./errors.js"
import { V2HomeConfigStore, type V2HomeConfig } from "./home-config.js"
import type { V2LifecycleAction, V2LifecycleLane } from "./lifecycle.js"
import { V2ProviderRegistry, type V2ProviderRegistryReport } from "./provider-contracts.js"
import { V2RigdActionPreflight, type V2RigdActionKind } from "./rigd-actions.js"
import { V2RigdStateStore, type V2DeploymentSnapshot, type V2PortReservation } from "./rigd-state.js"
import { V2RuntimeExecutor, type V2RuntimeExecutionResult } from "./runtime-executor.js"
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
  readonly runtime: V2ControlPlaneStatus
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
  readonly deployment?: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2RigdWebReadInput {
  readonly stateRoot: string
}

export interface V2RigdWebLogsInput {
  readonly stateRoot: string
  readonly project?: string
  readonly lane?: V2LifecycleLane
  readonly deployment?: string
  readonly component?: string
  readonly lines: number
}

export interface V2RigdWebProjectRow {
  readonly name: string
}

export interface V2RigdWebDeploymentRow {
  readonly project: string
  readonly name: string
  readonly kind: V2DeploymentRecord["kind"]
  readonly providerProfile: string
  readonly observedAt: string
}

export interface V2RigdWebHealthSnapshot {
  readonly rigd: {
    readonly status: "running" | "stale"
    readonly checkedAt?: string
    readonly providerProfile?: string
  }
  readonly deployments: readonly {
    readonly project: string
    readonly deployment: string
    readonly kind: V2DeploymentRecord["kind"]
    readonly status: "unknown" | "stale"
    readonly observedAt: string
  }[]
  readonly components: readonly {
    readonly project: string
    readonly deployment: string
    readonly component: string
    readonly port: number
    readonly status: "reserved" | "stale"
    readonly observedAt: string
  }[]
  readonly providers: readonly {
    readonly id: string
    readonly family: string
    readonly status: "confirmed" | "stale" | "missing"
    readonly observedAt: string
  }[]
}

export interface V2RigdWebReadModel {
  readonly projects: readonly V2RigdWebProjectRow[]
  readonly deployments: readonly V2RigdWebDeploymentRow[]
  readonly health: V2RigdWebHealthSnapshot
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
  readonly config?: V2ProjectConfig
}

export interface V2RigdControlPlaneLifecycleInput {
  readonly action: "up" | "down"
  readonly project: string
  readonly lane: V2LifecycleLane
  readonly stateRoot: string
  readonly config?: V2ProjectConfig
}

export interface V2RigdDeployInput {
  readonly project: string
  readonly target: "live" | "generated"
  readonly ref: string
  readonly stateRoot: string
  readonly deploymentName?: string
}

export interface V2RigdControlPlaneDeployInput extends V2RigdDeployInput {
  readonly config?: V2ProjectConfig
}

export interface V2RigdControlPlaneDestroyGeneratedInput {
  readonly project: string
  readonly target: "generated" | "local" | "live"
  readonly deploymentName: string
  readonly stateRoot: string
  readonly config: V2ProjectConfig
}

export interface V2RigdManagedProcessExitInput {
  readonly project: string
  readonly deployment: string
  readonly component: string
  readonly stateRoot: string
  readonly exitCode?: number
  readonly occurredAt?: string
  readonly stdout?: string
  readonly stderr?: string
}

export interface V2RigdManagedProcessExitResult {
  readonly action: "ignored" | "restarted" | "failed"
  readonly project: string
  readonly deployment: string
  readonly component: string
  readonly recentCrashCount: number
}

export interface V2RigdActionReceipt {
  readonly id: string
  readonly kind: V2RigdActionKind
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
  readonly controlPlaneLifecycle: (
    input: V2RigdControlPlaneLifecycleInput,
  ) => Effect.Effect<V2RigdActionReceipt, V2RuntimeError>
  readonly controlPlaneDeploy: (input: V2RigdControlPlaneDeployInput) => Effect.Effect<V2RigdActionReceipt, V2RuntimeError>
  readonly controlPlaneDestroyGenerated: (
    input: V2RigdControlPlaneDestroyGeneratedInput,
  ) => Effect.Effect<V2RigdActionReceipt, V2RuntimeError>
  readonly managedProcessExited: (
    input: V2RigdManagedProcessExitInput,
  ) => Effect.Effect<V2RigdManagedProcessExitResult, V2RuntimeError>
  readonly configRead: (input: V2ConfigReadInput) => Effect.Effect<V2ConfigReadModel, V2RuntimeError>
  readonly configPreview: (input: V2ConfigPreviewInput) => Effect.Effect<V2ConfigPreviewResult, V2RuntimeError>
  readonly configApply: (input: V2ConfigPreviewInput) => Effect.Effect<V2ConfigApplyResult, V2RuntimeError>
  readonly webReadModel: (input: V2RigdWebReadInput) => Effect.Effect<V2RigdWebReadModel, V2RuntimeError>
  readonly webLogs: (input: V2RigdWebLogsInput) => Effect.Effect<readonly V2RigdLogEntry[], V2RuntimeError>
}

export const V2Rigd = Context.Service<V2RigdService>("rig/v2/V2Rigd")

interface V2LifecycleRuntimeResult {
  readonly deployment: V2DeploymentRecord
  readonly execution: V2RuntimeExecutionResult
}

interface V2DeployRuntimeResult {
  readonly deployment: V2DeploymentRecord
  readonly execution: V2RuntimeExecutionResult
}

const controlPlaneContract = (runtime: V2ControlPlaneStatus): V2ControlPlaneContract => ({
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
  runtime,
})

const now = (): string => new Date().toISOString()
const CRASH_BACKOFF_WINDOW_MS = 5 * 60 * 1000
const MAX_RESTARTS_IN_BACKOFF_WINDOW = 2

const deploymentKindRank = (kind: V2DeploymentRecord["kind"]): number => {
  switch (kind) {
    case "local":
      return 0
    case "live":
      return 1
    case "generated":
      return 2
  }
}

export const V2RigdLive = Layer.effect(
  V2Rigd,
  Effect.gen(function* () {
    const runtime = yield* V2Runtime
    const deployments = yield* V2DeploymentManager
    const logger = yield* V2Logger
    const providerRegistry = yield* V2ProviderRegistry
    const stateStore = yield* V2RigdStateStore
    const controlPlane = yield* V2ControlPlane
    const actionPreflight = yield* V2RigdActionPreflight
    const configEditor = yield* V2ConfigEditor
    const runtimeExecutor = yield* V2RuntimeExecutor
    const startedAt = now()
    const events: V2RigdLogEntry[] = []

    const health = (stateRoot: string): Effect.Effect<V2RigdHealth> =>
      Effect.gen(function* () {
        const providers = yield* providerRegistry.current
        const controlPlaneStatus = yield* controlPlane.status
        const current = {
          service: "rigd",
          status: "running",
          stateRoot,
          startedAt,
          localApi: {
            transport: "in-process",
            version: "v2-mvp",
          },
          controlPlane: controlPlaneContract(controlPlaneStatus),
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

    const persistExecutionEvents = (
      stateRoot: string,
      execution: V2RuntimeExecutionResult | undefined,
    ): Effect.Effect<void, V2RuntimeError> =>
      Effect.gen(function* () {
        if (!execution) {
          return
        }

        for (const event of execution.events) {
          yield* appendEvent(stateRoot, event)
        }
      })

    const lifecycleAccepted = (
      input: V2RigdLifecycleInput,
      source: "cli" | "control-plane",
      execution?: V2RuntimeExecutionResult,
    ): Effect.Effect<V2RigdActionReceipt, V2RuntimeError> =>
      Effect.gen(function* () {
        const accepted = yield* receipt("lifecycle", input.project, input.stateRoot, input.lane)
        yield* persistExecutionEvents(input.stateRoot, execution)
        yield* appendEvent(input.stateRoot, {
          event: "rigd.lifecycle.accepted",
          project: input.project,
          lane: input.lane,
          details: {
            action: input.action,
            receiptId: accepted.id,
            source,
            ...(execution ? { execution } : {}),
          },
        })
        return accepted
      })

    const deployAccepted = (
      input: V2RigdDeployInput,
      target: string,
      source: "cli" | "control-plane",
      execution?: V2RuntimeExecutionResult,
    ): Effect.Effect<V2RigdActionReceipt, V2RuntimeError> =>
      Effect.gen(function* () {
        const accepted = yield* receipt("deploy", input.project, input.stateRoot, target)
        yield* persistExecutionEvents(input.stateRoot, execution)
        yield* appendEvent(input.stateRoot, {
          event: "rigd.deploy.accepted",
          project: input.project,
          deployment: input.target === "generated" ? target.replace(/^generated:/, "") : undefined,
          details: {
            target: input.target,
            ref: input.ref,
            deploymentName: input.deploymentName,
            receiptId: accepted.id,
            source,
            ...(execution ? { execution } : {}),
          },
        })
        return accepted
      })

    const generatedDeployTarget = (input: V2RigdDeployInput): string =>
      input.target === "generated" && input.deploymentName
        ? `${input.target}:${input.deploymentName}`
        : input.target

    const isLifecycleWriteAction = (action: V2LifecycleAction): action is "up" | "down" =>
      action === "up" || action === "down"

    const deploymentForLane = (
      config: V2ProjectConfig,
      stateRoot: string,
      lane: V2LifecycleLane,
    ): Effect.Effect<V2DeploymentRecord, V2RuntimeError> =>
      Effect.gen(function* () {
        const inventory = yield* deployments.list({ config, stateRoot })
        yield* persistInventoryEvidence(stateRoot, inventory)
        const found = inventory.find((deployment) => deployment.kind === lane)
        if (!found) {
          return yield* Effect.fail(
            new V2RuntimeError(
              `Unable to resolve ${lane} deployment for '${config.name}'.`,
              "Validate the v2 config and deployment inventory before retrying the runtime action.",
              { project: config.name, lane },
            ),
          )
        }
        return found
      })

    const lifecycleExecution = (
      input: V2RigdLifecycleInput,
    ): Effect.Effect<V2LifecycleRuntimeResult | undefined, V2RuntimeError> =>
      Effect.gen(function* () {
        if (!input.config || !isLifecycleWriteAction(input.action)) {
          return undefined
        }
        const deployment = yield* deploymentForLane(input.config, input.stateRoot, input.lane)
        const execution = yield* runtimeExecutor.lifecycle({
          action: input.action,
          deployment,
          onManagedProcessExit: managedProcessExitHandler(input.stateRoot),
        })
        return { deployment, execution }
      })

    const persistDesiredLifecycle = (
      input: V2RigdLifecycleInput,
      runtimeResult: V2LifecycleRuntimeResult | undefined,
    ): Effect.Effect<void, V2RuntimeError> =>
      runtimeResult
        ? stateStore.writeDesiredDeployment({
          stateRoot: input.stateRoot,
          desired: {
            project: runtimeResult.deployment.project,
            deployment: runtimeResult.deployment.name,
            kind: runtimeResult.deployment.kind,
            desiredStatus: input.action === "up" ? "running" : "stopped",
            updatedAt: now(),
            providerProfile: runtimeResult.deployment.providerProfile,
            record: runtimeResult.deployment,
          },
        })
        : Effect.void

    const persistDesiredDeployment = (
      stateRoot: string,
      deployment: V2DeploymentRecord,
      desiredStatus: "running" | "stopped" | "failed",
    ): Effect.Effect<void, V2RuntimeError> =>
      stateStore.writeDesiredDeployment({
        stateRoot,
        desired: {
          project: deployment.project,
          deployment: deployment.name,
          kind: deployment.kind,
          desiredStatus,
          updatedAt: now(),
          providerProfile: deployment.providerProfile,
          record: deployment,
        },
      })

    const recentFailuresForProcess = (
      failures: readonly {
        readonly project: string
        readonly deployment: string
        readonly component: string
        readonly occurredAt: string
      }[],
      input: V2RigdManagedProcessExitInput,
      occurredAt: string,
    ) => {
      const cutoff = new Date(occurredAt).getTime() - CRASH_BACKOFF_WINDOW_MS
      return failures.filter((failure) =>
        failure.project === input.project &&
        failure.deployment === input.deployment &&
        failure.component === input.component &&
        new Date(failure.occurredAt).getTime() >= cutoff
      )
    }

    const addMilliseconds = (timestamp: string, milliseconds: number): string =>
      new Date(new Date(timestamp).getTime() + milliseconds).toISOString()

    const crashPolicyDetails = (
      input: V2RigdManagedProcessExitInput,
      recent: readonly { readonly occurredAt: string }[],
      occurredAt: string,
      nextAction: "restart" | "leave-failed",
    ) => {
      const backoffWindowStartedAt = recent[0]?.occurredAt ?? occurredAt
      const remainingRestarts = Math.max(0, MAX_RESTARTS_IN_BACKOFF_WINDOW - recent.length)

      return {
        policy: "restart-with-backoff",
        failureOccurredAt: occurredAt,
        retryAttempt: recent.length,
        recentCrashCount: recent.length,
        maxRestarts: MAX_RESTARTS_IN_BACKOFF_WINDOW,
        remainingRestarts,
        restartBudgetExhausted: remainingRestarts === 0 && recent.length > MAX_RESTARTS_IN_BACKOFF_WINDOW,
        backoffWindowMs: CRASH_BACKOFF_WINDOW_MS,
        backoffWindowStartedAt,
        backoffWindowEndsAt: addMilliseconds(backoffWindowStartedAt, CRASH_BACKOFF_WINDOW_MS),
        nextAction,
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
        ...(input.stdout ? { stdout: input.stdout } : {}),
        ...(input.stderr ? { stderr: input.stderr } : {}),
      }
    }

    const ignoredProcessExit = (
      input: V2RigdManagedProcessExitInput,
      recentCrashCount: number,
      reason: string,
    ): Effect.Effect<V2RigdManagedProcessExitResult, V2RuntimeError> =>
      Effect.gen(function* () {
        yield* appendEvent(input.stateRoot, {
          event: "rigd.process.exit-ignored",
          project: input.project,
          deployment: input.deployment,
          component: input.component,
          details: {
            reason,
            exitCode: input.exitCode,
          },
        })
        return {
          action: "ignored",
          project: input.project,
          deployment: input.deployment,
          component: input.component,
          recentCrashCount,
        }
      })

    const handleManagedProcessExit = (
      input: V2RigdManagedProcessExitInput,
    ): Effect.Effect<V2RigdManagedProcessExitResult, V2RuntimeError> =>
      Effect.gen(function* () {
        const occurredAt = input.occurredAt ?? now()
        const state = yield* stateStore.load({ stateRoot: input.stateRoot })
        const desired = state.desiredDeployments.find((candidate) =>
          candidate.project === input.project &&
          candidate.deployment === input.deployment
        )

        if (!desired || desired.desiredStatus !== "running") {
          return yield* ignoredProcessExit(input, 0, desired ? `desired-${desired.desiredStatus}` : "not-desired")
        }

        const failure = {
          project: input.project,
          deployment: input.deployment,
          component: input.component,
          occurredAt,
          ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
          ...(input.stdout ? { stdout: input.stdout } : {}),
          ...(input.stderr ? { stderr: input.stderr } : {}),
        }
        const recent = recentFailuresForProcess(
          [...state.managedServiceFailures, failure],
          input,
          occurredAt,
        )
        yield* stateStore.appendManagedServiceFailure({
          stateRoot: input.stateRoot,
          failure,
        })

        if (recent.length <= MAX_RESTARTS_IN_BACKOFF_WINDOW) {
          const execution = yield* runtimeExecutor.lifecycle({
            action: "up",
            deployment: desired.record,
            onManagedProcessExit: managedProcessExitHandler(input.stateRoot),
          })
          yield* persistExecutionEvents(input.stateRoot, execution)
          yield* appendEvent(input.stateRoot, {
            event: "rigd.process.restarted",
            project: input.project,
            ...(desired.kind === "local" || desired.kind === "live" ? { lane: desired.kind } : {}),
            deployment: input.deployment,
            component: input.component,
            details: {
              reason: "managed-process-exited",
              ...crashPolicyDetails(input, recent, occurredAt, "restart"),
              restartBudgetExhausted: false,
              desiredStatus: "running",
              execution,
            },
          })
          return {
            action: "restarted",
            project: input.project,
            deployment: input.deployment,
            component: input.component,
            recentCrashCount: recent.length,
          }
        }

        yield* persistDesiredDeployment(input.stateRoot, desired.record, "failed")
        yield* appendEvent(input.stateRoot, {
          event: "rigd.process.failed",
          project: input.project,
          ...(desired.kind === "local" || desired.kind === "live" ? { lane: desired.kind } : {}),
          deployment: input.deployment,
          component: input.component,
          details: {
            reason: "restart-budget-exhausted",
            ...crashPolicyDetails(input, recent, occurredAt, "leave-failed"),
            restartBudgetExhausted: true,
            finalDesiredStatus: "failed",
          },
        })
        return {
          action: "failed",
          project: input.project,
          deployment: input.deployment,
          component: input.component,
          recentCrashCount: recent.length,
        }
      })

    const managedProcessExitHandler = (stateRoot: string) => (
      exit: {
        readonly deployment: V2DeploymentRecord
        readonly service: V2DeploymentRecord["resolved"]["environment"]["services"][number]
        readonly exitCode?: number
        readonly stdout?: string
        readonly stderr?: string
      },
    ): Effect.Effect<void, V2RuntimeError> =>
      handleManagedProcessExit({
        project: exit.deployment.project,
        deployment: exit.deployment.name,
        component: exit.service.name,
        stateRoot,
        ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
        ...(exit.stdout ? { stdout: exit.stdout } : {}),
        ...(exit.stderr ? { stderr: exit.stderr } : {}),
      }).pipe(Effect.asVoid)

    const reconcileDesiredRunning = (
      stateRoot: string,
    ): Effect.Effect<void, V2RuntimeError> =>
      Effect.gen(function* () {
        const state = yield* stateStore.load({ stateRoot })
        const desiredRunning = state.desiredDeployments.filter((desired) => desired.desiredStatus === "running")

        for (const desired of desiredRunning) {
          const execution = yield* runtimeExecutor.lifecycle({
            action: "up",
            deployment: desired.record,
            onManagedProcessExit: managedProcessExitHandler(stateRoot),
          })
          yield* persistExecutionEvents(stateRoot, execution)
          yield* appendEvent(stateRoot, {
            event: "rigd.reconcile.deployment-started",
            project: desired.project,
            ...(desired.kind === "local" || desired.kind === "live" ? { lane: desired.kind } : {}),
            deployment: desired.deployment,
            details: {
              reason: "desired-running",
              execution,
            },
          })
        }
      })

    const deployExecution = (
      input: V2RigdControlPlaneDeployInput,
      generatedDeployment?: V2DeploymentRecord,
    ): Effect.Effect<V2DeployRuntimeResult | undefined, V2RuntimeError> =>
      Effect.gen(function* () {
        if (generatedDeployment) {
          const execution = yield* runtimeExecutor.deploy({
            deployment: generatedDeployment,
            ref: input.ref,
            onManagedProcessExit: managedProcessExitHandler(input.stateRoot),
          })
          return { deployment: generatedDeployment, execution }
        }

        if (!input.config) {
          return undefined
        }

        const deployment = yield* deploymentForLane(input.config, input.stateRoot, "live")
        const execution = yield* runtimeExecutor.deploy({
          deployment,
          ref: input.ref,
          onManagedProcessExit: managedProcessExitHandler(input.stateRoot),
        })
        return { deployment, execution }
      })

    const enforceGeneratedDeploymentCap = (
      input: V2RigdControlPlaneDeployInput,
      homeConfig: V2HomeConfig,
    ): Effect.Effect<void, V2RuntimeError> =>
      Effect.gen(function* () {
        if (input.target !== "generated" || !input.config) {
          return
        }

        const requestedDeployment = branchSlug(input.deploymentName ?? input.ref)
        const inventory = yield* deployments.list({
          config: input.config,
          stateRoot: input.stateRoot,
        })
        const generated = inventory.filter((deployment) => deployment.kind === "generated")
        const existing = generated.find((deployment) => deployment.name === requestedDeployment)

        if (existing || generated.length < homeConfig.deploy.generated.maxActive) {
          return
        }

        if (homeConfig.deploy.generated.replacePolicy === "reject") {
          return yield* Effect.fail(
            new V2RuntimeError(
              `Generated deployment cap reached for '${input.project}'.`,
              "Destroy an existing generated deployment or raise deploy.generated.maxActive in the home rig config.",
              {
                reason: "generated-deployment-cap-reached",
                project: input.project,
                maxActive: homeConfig.deploy.generated.maxActive,
                replacePolicy: homeConfig.deploy.generated.replacePolicy,
                requestedDeployment,
                activeDeployments: generated.map((deployment) => deployment.name),
              },
            ),
          )
        }

        const oldest = generated[0]
        if (!oldest) {
          return
        }

        yield* deployments.destroyGenerated({
          config: input.config,
          stateRoot: input.stateRoot,
          name: oldest.name,
        })
        yield* appendEvent(input.stateRoot, {
          event: "rigd.generated.cap-replaced",
          project: input.project,
          deployment: oldest.name,
          details: {
            reason: "generated-deployment-cap-reached",
            maxActive: homeConfig.deploy.generated.maxActive,
            replacePolicy: homeConfig.deploy.generated.replacePolicy,
            requestedDeployment,
            replacedDeployment: oldest.name,
          },
        })
      })

    return {
      start: (input) =>
        Effect.gen(function* () {
          yield* controlPlane.start({ exposure: "localhost-only" })
          yield* appendEvent(input.stateRoot, {
            event: "rigd.started",
            details: {
              stateRoot: input.stateRoot,
            },
          })
          yield* reconcileDesiredRunning(input.stateRoot)
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
          const runtimeResult = yield* lifecycleExecution(input)
          yield* persistDesiredLifecycle(input, runtimeResult)
          return yield* lifecycleAccepted(input, "cli", runtimeResult?.execution)
        }),
      deploy: (input) =>
        Effect.gen(function* () {
          return yield* deployAccepted(input, generatedDeployTarget(input), "cli")
        }),
      controlPlaneLifecycle: (input) =>
        Effect.gen(function* () {
          if (!isLifecycleWriteAction(input.action)) {
            return yield* Effect.fail(
              new V2RuntimeError(
                "Control-plane lifecycle write action must be up or down.",
                "Use the read-side log or status endpoints for non-mutating lifecycle views.",
                {
                  reason: "invalid-lifecycle-action",
                  project: input.project,
                  action: input.action,
                },
              ),
            )
          }
          yield* actionPreflight.verify({
            kind: "lifecycle",
            project: input.project,
            stateRoot: input.stateRoot,
            target: input.lane,
          })
          const runtimeResult = yield* lifecycleExecution(input)
          yield* persistDesiredLifecycle(input, runtimeResult)
          return yield* lifecycleAccepted(input, "control-plane", runtimeResult?.execution)
        }),
      controlPlaneDeploy: (input) =>
        Effect.gen(function* () {
          if (input.target !== "live" && input.target !== "generated") {
            return yield* Effect.fail(
              new V2RuntimeError(
                "Control-plane deploy action target must be live or generated.",
                "Choose live or a generated deployment target before requesting deploy.",
                {
                  reason: "invalid-deploy-target",
                  project: input.project,
                  target: input.target,
                },
              ),
            )
          }
          let target = generatedDeployTarget(input)
          const generatedConfig = input.target === "generated" ? input.config : undefined
          if (input.target === "generated") {
            if (!generatedConfig) {
              return yield* Effect.fail(
                new V2RuntimeError(
                  "Generated deployment control-plane action requires project config.",
                  "Load and validate the v2 project config before requesting a generated deployment action.",
                  {
                    reason: "missing-generated-config",
                    project: input.project,
                    target: input.target,
                  },
                ),
              )
            }
            target = `generated:${branchSlug(input.deploymentName ?? input.ref)}`
          }

          yield* actionPreflight.verify({
            kind: "deploy",
            project: input.project,
            stateRoot: input.stateRoot,
            target,
          })

          let materialized: V2DeploymentRecord | undefined
          if (input.target === "generated") {
            const homeConfigStore = yield* V2HomeConfigStore
            const homeConfig = yield* homeConfigStore.read({ stateRoot: input.stateRoot })
            yield* enforceGeneratedDeploymentCap(input, homeConfig)
            materialized = yield* deployments.materializeGenerated({
              config: generatedConfig,
              stateRoot: input.stateRoot,
              branch: input.ref,
              name: input.deploymentName,
            })
            target = `generated:${materialized.name}`
            const inventory = yield* deployments.list({
              config: generatedConfig,
              stateRoot: input.stateRoot,
            })
            yield* persistInventoryEvidence(input.stateRoot, inventory)
          }

          const runtimeResult = yield* deployExecution(input, materialized)
          if (runtimeResult) {
            yield* persistDesiredDeployment(input.stateRoot, runtimeResult.deployment, "running")
          }
          return yield* deployAccepted(input, target, "control-plane", runtimeResult?.execution)
        }),
      controlPlaneDestroyGenerated: (input) =>
        Effect.gen(function* () {
          if (input.target !== "generated") {
            return yield* Effect.fail(
              new V2RuntimeError(
                "Generated deployment destroy action cannot target local or live.",
                "Choose a generated deployment name before requesting teardown.",
                {
                  reason: "invalid-destroy-target",
                  project: input.project,
                  target: input.target,
                  deploymentName: input.deploymentName,
                },
              ),
            )
          }
          const target = `generated:${input.deploymentName}`
          yield* actionPreflight.verify({
            kind: "destroy",
            project: input.project,
            stateRoot: input.stateRoot,
            target,
          })
          const destroyed = yield* deployments.destroyGenerated({
            config: input.config,
            stateRoot: input.stateRoot,
            name: input.deploymentName,
          })
          const execution = yield* runtimeExecutor.destroyGenerated({ deployment: destroyed })
          yield* persistDesiredDeployment(input.stateRoot, destroyed, "stopped")
          const inventory = yield* deployments.list({
            config: input.config,
            stateRoot: input.stateRoot,
          })
          yield* persistInventoryEvidence(input.stateRoot, inventory)
          const accepted = yield* receipt("destroy", input.project, input.stateRoot, target)
          yield* persistExecutionEvents(input.stateRoot, execution)
          yield* appendEvent(input.stateRoot, {
            event: "rigd.generated.destroy.accepted",
            project: input.project,
            deployment: destroyed.name,
            details: {
              receiptId: accepted.id,
              source: "control-plane",
              execution,
            },
          })
          return accepted
        }),
      managedProcessExited: (input) => handleManagedProcessExit(input),
      configRead: (input) => configEditor.read(input),
      configPreview: (input) => configEditor.preview(input),
      configApply: (input) => configEditor.apply(input),
      webReadModel: (input) =>
        Effect.gen(function* () {
          const state = yield* stateStore.load({ stateRoot: input.stateRoot })
          const latestHealth = state.healthSummaries.at(-1)
          const projectNames = new Set<string>()

          for (const snapshot of state.deploymentSnapshots) {
            projectNames.add(snapshot.project)
          }
          for (const reservation of state.portReservations) {
            projectNames.add(reservation.project)
          }
          for (const event of state.events) {
            if (event.project) {
              projectNames.add(event.project)
            }
          }

          const deployments = [...state.deploymentSnapshots]
            .sort((left, right) =>
              left.project.localeCompare(right.project) ||
              deploymentKindRank(left.kind) - deploymentKindRank(right.kind) ||
              left.deployment.localeCompare(right.deployment)
            )
            .map((snapshot) => ({
              project: snapshot.project,
              name: snapshot.deployment,
              kind: snapshot.kind,
              providerProfile: snapshot.providerProfile,
              observedAt: snapshot.observedAt,
            }))

          return {
            projects: [...projectNames].sort().map((name) => ({ name })),
            deployments,
            health: {
              rigd: latestHealth
                ? {
                  status: latestHealth.status,
                  checkedAt: latestHealth.checkedAt,
                  providerProfile: latestHealth.providerProfile,
                }
                : {
                  status: "stale" as const,
                },
              deployments: state.deploymentSnapshots.map((snapshot) => ({
                project: snapshot.project,
                deployment: snapshot.deployment,
                kind: snapshot.kind,
                status: "unknown" as const,
                observedAt: snapshot.observedAt,
              })),
              components: state.portReservations.map((reservation) => ({
                project: reservation.project,
                deployment: reservation.deployment,
                component: reservation.component,
                port: reservation.port,
                status: reservation.status,
                observedAt: reservation.observedAt,
              })),
              providers: state.providerObservations.map((provider) => ({
                id: provider.id,
                family: provider.family,
                status: provider.status,
                observedAt: provider.observedAt,
              })),
            },
          }
        }),
      webLogs: (input) =>
        Effect.gen(function* () {
          const state = yield* stateStore.load({ stateRoot: input.stateRoot })
          const filtered = state.events
            .filter((entry) => input.project === undefined || entry.project === input.project)
            .filter((entry) => input.lane === undefined || entry.lane === input.lane)
            .filter((entry) => input.deployment === undefined || entry.deployment === input.deployment)
            .filter((entry) => input.component === undefined || entry.component === input.component)
          return filtered.slice(Math.max(0, filtered.length - input.lines))
        }),
    } satisfies V2RigdService
  }),
)
