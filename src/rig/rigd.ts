import { Context, Effect, Layer } from "effect"

import type { RigProjectConfig } from "./config.js"
import {
  RigConfigEditor,
  type RigConfigApplyResult,
  type RigConfigPreviewInput,
  type RigConfigPreviewResult,
  type RigConfigReadInput,
  type RigConfigReadModel,
} from "./config-editor.js"
import { RigControlPlane, type RigControlPlaneStatus } from "./control-plane.js"
import { branchSlug, RigDeploymentManager, type RigDeploymentRecord } from "./deployments.js"
import { RigRuntimeError } from "./errors.js"
import { RigHomeConfigStore, type RigHomeConfig } from "./home-config.js"
import type { RigLifecycleLane, RigLifecycleWriteAction } from "./lifecycle.js"
import { RigProviderRegistry, type RigProviderRegistryReport } from "./provider-contracts.js"
import { verifyRigdActionPreflight, RigdActionPreflight, type RigdActionKind, type RigdActionPreflightInput } from "./rigd-actions.js"
import { RigdStateStore } from "./rigd-state.js"
import { makeRigRuntimeJournal } from "./runtime-journal.js"
import { deriveRigRuntimeLogWindow, deriveRigRuntimeWebReadModel } from "./runtime-read-models.js"
import { RigRuntimeExecutor, type RigRuntimeExecutionResult } from "./runtime-executor.js"
import { RigLogger, RigRuntime, type RigFoundationState } from "./services.js"

export interface RigControlPlaneContract {
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
  readonly runtime: RigControlPlaneStatus
}

export interface RigdHealth {
  readonly service: "rigd"
  readonly status: "running"
  readonly stateRoot: string
  readonly startedAt: string
  readonly localApi: {
    readonly transport: "in-process"
    readonly version: "rig-mvp"
  }
  readonly controlPlane: RigControlPlaneContract
  readonly providers: RigProviderRegistryReport
}

export interface RigdStartInput {
  readonly stateRoot: string
}

export interface RigdProjectInventoryInput {
  readonly project: string
  readonly stateRoot: string
  readonly config?: RigProjectConfig
}

export interface RigdInventory {
  readonly project: string
  readonly foundation: RigFoundationState
  readonly deployments: readonly RigDeploymentRecord[]
}

export interface RigdLogInput {
  readonly project: string
  readonly stateRoot: string
  readonly lines: number
  readonly lane?: RigLifecycleLane
}

export interface RigdLogEntry {
  readonly timestamp: string
  readonly event: string
  readonly project?: string
  readonly lane?: string
  readonly deployment?: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigdWebReadInput {
  readonly stateRoot: string
}

export interface RigdWebLogsInput {
  readonly stateRoot: string
  readonly project?: string
  readonly lane?: RigLifecycleLane
  readonly deployment?: string
  readonly component?: string
  readonly lines: number
}

export interface RigdWebProjectRow {
  readonly name: string
}

export interface RigdWebDeploymentRow {
  readonly project: string
  readonly name: string
  readonly kind: RigDeploymentRecord["kind"]
  readonly providerProfile: string
  readonly observedAt: string
}

export interface RigdWebHealthSnapshot {
  readonly rigd: {
    readonly status: "running" | "stale"
    readonly checkedAt?: string
    readonly providerProfile?: string
  }
  readonly deployments: readonly {
    readonly project: string
    readonly deployment: string
    readonly kind: RigDeploymentRecord["kind"]
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

export interface RigdWebReadModel {
  readonly projects: readonly RigdWebProjectRow[]
  readonly deployments: readonly RigdWebDeploymentRow[]
  readonly health: RigdWebHealthSnapshot
}

export interface RigdHealthStateInput {
  readonly project: string
  readonly stateRoot: string
  readonly config?: RigProjectConfig
}

export interface RigdHealthState {
  readonly rigd: RigdHealth
  readonly deployments: readonly {
    readonly name: string
    readonly kind: RigDeploymentRecord["kind"]
    readonly status: "unknown"
  }[]
  readonly desiredDeployments: readonly {
    readonly name: string
    readonly kind: RigDeploymentRecord["kind"]
    readonly desiredStatus: "running" | "stopped" | "failed"
    readonly updatedAt: string
  }[]
  readonly managedServiceFailures: readonly {
    readonly deployment: string
    readonly component: string
    readonly occurredAt: string
    readonly exitCode?: number
    readonly stdout?: string
    readonly stderr?: string
    readonly recentCrashCount: number
  }[]
}

export interface RigdLifecycleInput {
  readonly action: RigLifecycleWriteAction
  readonly project: string
  readonly lane: RigLifecycleLane
  readonly stateRoot: string
  readonly config?: RigProjectConfig
}

export interface RigdControlPlaneLifecycleInput {
  readonly action: "up" | "down"
  readonly project: string
  readonly lane: RigLifecycleLane
  readonly stateRoot: string
  readonly config?: RigProjectConfig
}

export interface RigdDeployInput {
  readonly project: string
  readonly target: "live" | "generated"
  readonly ref: string
  readonly stateRoot: string
  readonly deploymentName?: string
  readonly config?: RigProjectConfig
}

export interface RigdControlPlaneDeployInput extends RigdDeployInput {
  readonly config?: RigProjectConfig
}

export interface RigdControlPlaneDestroyGeneratedInput {
  readonly project: string
  readonly target: "generated" | "local" | "live"
  readonly deploymentName: string
  readonly stateRoot: string
  readonly config: RigProjectConfig
}

export interface RigdManagedProcessExitInput {
  readonly project: string
  readonly deployment: string
  readonly component: string
  readonly stateRoot: string
  readonly exitCode?: number
  readonly occurredAt?: string
  readonly stdout?: string
  readonly stderr?: string
}

export interface RigdManagedProcessExitResult {
  readonly action: "ignored" | "restarted" | "failed"
  readonly project: string
  readonly deployment: string
  readonly component: string
  readonly recentCrashCount: number
}

export interface RigdActionReceipt {
  readonly id: string
  readonly kind: RigdActionKind
  readonly accepted: true
  readonly project: string
  readonly stateRoot: string
  readonly target: string
  readonly receivedAt: string
}

export interface RigdService {
  readonly start: (input: RigdStartInput) => Effect.Effect<RigdHealth, RigRuntimeError>
  readonly health: (input: RigdStartInput) => Effect.Effect<RigdHealth, RigRuntimeError>
  readonly inventory: (input: RigdProjectInventoryInput) => Effect.Effect<RigdInventory, RigRuntimeError>
  readonly logs: (input: RigdLogInput) => Effect.Effect<readonly RigdLogEntry[], RigRuntimeError>
  readonly healthState: (input: RigdHealthStateInput) => Effect.Effect<RigdHealthState, RigRuntimeError>
  readonly lifecycle: (input: RigdLifecycleInput) => Effect.Effect<RigdActionReceipt, RigRuntimeError>
  readonly deploy: (input: RigdDeployInput) => Effect.Effect<RigdActionReceipt, RigRuntimeError>
  readonly controlPlaneLifecycle: (
    input: RigdControlPlaneLifecycleInput,
  ) => Effect.Effect<RigdActionReceipt, RigRuntimeError>
  readonly controlPlaneDeploy: (input: RigdControlPlaneDeployInput) => Effect.Effect<RigdActionReceipt, RigRuntimeError>
  readonly controlPlaneDestroyGenerated: (
    input: RigdControlPlaneDestroyGeneratedInput,
  ) => Effect.Effect<RigdActionReceipt, RigRuntimeError>
  readonly managedProcessExited: (
    input: RigdManagedProcessExitInput,
  ) => Effect.Effect<RigdManagedProcessExitResult, RigRuntimeError>
  readonly configRead: (input: RigConfigReadInput) => Effect.Effect<RigConfigReadModel, RigRuntimeError>
  readonly configPreview: (input: RigConfigPreviewInput) => Effect.Effect<RigConfigPreviewResult, RigRuntimeError>
  readonly configApply: (input: RigConfigPreviewInput) => Effect.Effect<RigConfigApplyResult, RigRuntimeError>
  readonly webReadModel: (input: RigdWebReadInput) => Effect.Effect<RigdWebReadModel, RigRuntimeError>
  readonly webLogs: (input: RigdWebLogsInput) => Effect.Effect<readonly RigdLogEntry[], RigRuntimeError>
}

export const Rigd = Context.Service<RigdService>("rig/rig/Rigd")

interface RigLifecycleRuntimeResult {
  readonly deployment: RigDeploymentRecord
  readonly execution: RigRuntimeExecutionResult
}

interface RigDeployRuntimeResult {
  readonly deployment: RigDeploymentRecord
  readonly execution: RigRuntimeExecutionResult
}

const controlPlaneContract = (runtime: RigControlPlaneStatus): RigControlPlaneContract => ({
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

export const RigdLive = Layer.effect(
  Rigd,
  Effect.gen(function* () {
    const runtime = yield* RigRuntime
    const deployments = yield* RigDeploymentManager
    const logger = yield* RigLogger
    const providerRegistry = yield* RigProviderRegistry
    const stateStore = yield* RigdStateStore
    const controlPlane = yield* RigControlPlane
    const actionPreflight = yield* RigdActionPreflight
    const configEditor = yield* RigConfigEditor
    const runtimeExecutor = yield* RigRuntimeExecutor
    const startedAt = now()
    const events: RigdLogEntry[] = []
    const journal = makeRigRuntimeJournal({
      stateStore,
      now,
      onEvent: (event) => {
        events.push(event)
      },
    })
    const verifyActionPreflight = (
      input: RigdActionPreflightInput,
    ): Effect.Effect<void, RigRuntimeError> =>
      Effect.gen(function* () {
        yield* verifyRigdActionPreflight(input, {
          deployments,
          stateStore,
          providerRegistry,
        })
        yield* actionPreflight.verify(input)
      })

    const health = (stateRoot: string): Effect.Effect<RigdHealth> =>
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
            version: "rig-mvp",
          },
          controlPlane: controlPlaneContract(controlPlaneStatus),
          providers,
        } satisfies RigdHealth

        yield* journal.recordHealth({
          stateRoot,
          providerProfile: providers.profile,
          providers: providers.providers.map((provider) => ({
            id: provider.id,
            family: provider.family,
            status: "confirmed" as const,
            capabilities: provider.capabilities,
          })),
        })

        return current
      })

    const persistInventoryEvidence = (
      stateRoot: string,
      deploymentInventory: readonly RigDeploymentRecord[],
    ): Effect.Effect<void, RigRuntimeError> =>
      journal.recordDeploymentInventory({
        stateRoot,
        deployments: deploymentInventory,
      })

    const appendEvent = (
      stateRoot: string,
      entry: Omit<RigdLogEntry, "timestamp">,
    ): Effect.Effect<void, RigRuntimeError> =>
      journal.recordEvent({
        stateRoot,
        event: entry,
      })

    const receipt = (
      kind: RigdActionReceipt["kind"],
      project: string,
      stateRoot: string,
      target: string,
    ): Effect.Effect<RigdActionReceipt, RigRuntimeError> =>
      journal.recordReceipt({
        kind,
        project,
        stateRoot,
        target,
      })

    const persistExecutionEvents = (
      stateRoot: string,
      execution: RigRuntimeExecutionResult | undefined,
    ): Effect.Effect<void, RigRuntimeError> =>
      journal.recordExecutionEvents({
        stateRoot,
        ...(execution ? { execution } : {}),
      })

    const lifecycleAccepted = (
      input: RigdLifecycleInput,
      source: "cli" | "control-plane",
      execution?: RigRuntimeExecutionResult,
    ): Effect.Effect<RigdActionReceipt, RigRuntimeError> =>
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
      input: RigdDeployInput,
      target: string,
      source: "cli" | "control-plane",
      execution?: RigRuntimeExecutionResult,
    ): Effect.Effect<RigdActionReceipt, RigRuntimeError> =>
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

    const generatedDeployTarget = (input: RigdDeployInput): string =>
      input.target === "generated" && input.deploymentName
        ? `${input.target}:${input.deploymentName}`
        : input.target

    const isLifecycleWriteAction = (action: unknown): action is RigLifecycleWriteAction =>
      action === "up" || action === "down"

    const deploymentForLane = (
      config: RigProjectConfig,
      stateRoot: string,
      lane: RigLifecycleLane,
    ): Effect.Effect<RigDeploymentRecord, RigRuntimeError> =>
      Effect.gen(function* () {
        const inventory = yield* deployments.list({ config, stateRoot })
        yield* persistInventoryEvidence(stateRoot, inventory)
        const found = inventory.find((deployment) => deployment.kind === lane)
        if (!found) {
          return yield* Effect.fail(
            new RigRuntimeError(
              `Unable to resolve ${lane} deployment for '${config.name}'.`,
              "Validate the rig config and deployment inventory before retrying the runtime action.",
              { project: config.name, lane },
            ),
          )
        }
        return found
      })

    const lifecycleExecution = (
      input: RigdLifecycleInput,
    ): Effect.Effect<RigLifecycleRuntimeResult | undefined, RigRuntimeError> =>
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
      input: RigdLifecycleInput,
      runtimeResult: RigLifecycleRuntimeResult | undefined,
    ): Effect.Effect<void, RigRuntimeError> =>
      runtimeResult
        ? journal.recordDesiredDeployment({
          stateRoot: input.stateRoot,
          deployment: runtimeResult.deployment,
          desiredStatus: input.action === "up" ? "running" : "stopped",
        })
        : Effect.void

    const persistDesiredDeployment = (
      stateRoot: string,
      deployment: RigDeploymentRecord,
      desiredStatus: "running" | "stopped" | "failed",
    ): Effect.Effect<void, RigRuntimeError> =>
      journal.recordDesiredDeployment({
        stateRoot,
        deployment,
        desiredStatus,
      })

    const recentFailuresForProcess = (
      failures: readonly {
        readonly project: string
        readonly deployment: string
        readonly component: string
        readonly occurredAt: string
      }[],
      input: RigdManagedProcessExitInput,
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
      input: RigdManagedProcessExitInput,
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
      input: RigdManagedProcessExitInput,
      recentCrashCount: number,
      reason: string,
    ): Effect.Effect<RigdManagedProcessExitResult, RigRuntimeError> =>
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
      input: RigdManagedProcessExitInput,
    ): Effect.Effect<RigdManagedProcessExitResult, RigRuntimeError> =>
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
        yield* journal.recordManagedServiceFailure({
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
        readonly deployment: RigDeploymentRecord
        readonly service: RigDeploymentRecord["resolved"]["environment"]["services"][number]
        readonly exitCode?: number
        readonly stdout?: string
        readonly stderr?: string
      },
    ): Effect.Effect<void, RigRuntimeError> =>
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
    ): Effect.Effect<void, RigRuntimeError> =>
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
      input: RigdControlPlaneDeployInput,
      generatedDeployment?: RigDeploymentRecord,
    ): Effect.Effect<RigDeployRuntimeResult | undefined, RigRuntimeError> =>
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

    const rollbackGeneratedDeployFailure = (
      input: RigdControlPlaneDeployInput,
      deployment: RigDeploymentRecord,
      previous: RigDeploymentRecord | undefined,
      deployError: RigRuntimeError,
    ): Effect.Effect<never, RigRuntimeError> =>
      Effect.gen(function* () {
        if (!input.config) {
          return yield* Effect.fail(deployError)
        }

        if (previous) {
          const restoreError = yield* deployments.restoreGenerated({
            config: input.config,
            stateRoot: input.stateRoot,
            record: previous,
          }).pipe(
            Effect.as(undefined),
            Effect.catch((error) => Effect.succeed(error)),
          )

          if (!restoreError) {
            const inventory = yield* deployments.list({
              config: input.config,
              stateRoot: input.stateRoot,
            })
            yield* persistInventoryEvidence(input.stateRoot, inventory)
            return yield* Effect.fail(deployError)
          }

          return yield* Effect.fail(
            new RigRuntimeError(
              `Generated deploy '${deployment.name}' failed and previous deployment restore failed.`,
              "Inspect the generated deployment inventory and restore or destroy the deployment before retrying.",
              {
                reason: "generated-deploy-restore-failed",
                project: deployment.project,
                deployment: deployment.name,
                deployError: deployError.message,
                restoreError: restoreError.message,
              },
            ),
          )
        }

        const cleanupError = yield* runtimeExecutor.destroyGenerated({ deployment }).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error)),
        )
        const inventoryError = yield* deployments.destroyGenerated({
          config: input.config,
          stateRoot: input.stateRoot,
          name: deployment.name,
        }).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error)),
        )

        if (!inventoryError) {
          const inventory = yield* deployments.list({
            config: input.config,
            stateRoot: input.stateRoot,
          })
          yield* persistInventoryEvidence(input.stateRoot, inventory)
        }

        if (cleanupError || inventoryError) {
          return yield* Effect.fail(
            new RigRuntimeError(
              `Generated deploy '${deployment.name}' failed and rollback was incomplete.`,
              "Inspect the generated deployment workspace, process supervisor, and runtime inventory before retrying.",
              {
                reason: "generated-deploy-rollback-failed",
                project: deployment.project,
                deployment: deployment.name,
                deployError: deployError.message,
                ...(cleanupError ? { cleanupError: cleanupError.message } : {}),
                ...(inventoryError ? { inventoryError: inventoryError.message } : {}),
              },
            ),
          )
        }

        return yield* Effect.fail(deployError)
      })

    const enforceGeneratedDeploymentCap = (
      input: RigdControlPlaneDeployInput,
      homeConfig: RigHomeConfig,
    ): Effect.Effect<RigDeploymentRecord | undefined, RigRuntimeError> =>
      Effect.gen(function* () {
        if (input.target !== "generated" || !input.config) {
          return undefined
        }

        const requestedDeployment = branchSlug(input.deploymentName ?? input.ref)
        const inventory = yield* deployments.list({
          config: input.config,
          stateRoot: input.stateRoot,
        })
        const generated = inventory.filter((deployment) => deployment.kind === "generated")
        const existing = generated.find((deployment) => deployment.name === requestedDeployment)

        if (existing || generated.length < homeConfig.deploy.generated.maxActive) {
          return undefined
        }

        if (homeConfig.deploy.generated.replacePolicy === "reject") {
          return yield* Effect.fail(
            new RigRuntimeError(
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
          return undefined
        }

        return oldest
      })

    const replaceGeneratedAfterSuccessfulDeploy = (
      input: RigdControlPlaneDeployInput,
      replaced: RigDeploymentRecord,
      requestedDeployment: string,
      homeConfig: RigHomeConfig,
    ): Effect.Effect<void, RigRuntimeError> =>
      Effect.gen(function* () {
        if (!input.config) {
          return
        }

        const execution = yield* runtimeExecutor.destroyGenerated({ deployment: replaced })
        yield* persistExecutionEvents(input.stateRoot, execution)
        yield* persistDesiredDeployment(input.stateRoot, replaced, "stopped")
        yield* deployments.destroyGenerated({
          config: input.config,
          stateRoot: input.stateRoot,
          name: replaced.name,
        })
        yield* appendEvent(input.stateRoot, {
          event: "rigd.generated.cap-replaced",
          project: input.project,
          deployment: replaced.name,
          details: {
            reason: "generated-deployment-cap-reached",
            maxActive: homeConfig.deploy.generated.maxActive,
            replacePolicy: homeConfig.deploy.generated.replacePolicy,
            requestedDeployment,
            replacedDeployment: replaced.name,
            execution,
          },
        })
      })

    const runDeployAction = (
      input: RigdControlPlaneDeployInput,
      source: "cli" | "control-plane",
    ): Effect.Effect<RigdActionReceipt, RigRuntimeError> =>
      Effect.gen(function* () {
        if (input.target !== "live" && input.target !== "generated") {
          return yield* Effect.fail(
            new RigRuntimeError(
              source === "control-plane"
                ? "Control-plane deploy action target must be live or generated."
                : "Deploy action target must be live or generated.",
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
              new RigRuntimeError(
                source === "control-plane"
                  ? "Generated deployment control-plane action requires project config."
                  : "Generated deployment action requires project config.",
                "Load and validate the rig project config before requesting a generated deployment action.",
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

        yield* verifyActionPreflight({
          kind: "deploy",
          project: input.project,
          stateRoot: input.stateRoot,
          target,
          ...(input.target === "generated" ? { ref: input.ref } : {}),
          ...(input.deploymentName ? { deploymentName: input.deploymentName } : {}),
          ...(input.config ? { config: input.config } : {}),
        })

        let materialized: RigDeploymentRecord | undefined
        let previousGenerated: RigDeploymentRecord | undefined
        let replacedGenerated: RigDeploymentRecord | undefined
        let homeConfig: RigHomeConfig | undefined
        if (input.target === "generated") {
          const homeConfigStore = yield* RigHomeConfigStore
          homeConfig = yield* homeConfigStore.read({ stateRoot: input.stateRoot })
          replacedGenerated = yield* enforceGeneratedDeploymentCap(input, homeConfig)
          const requestedDeployment = branchSlug(input.deploymentName ?? input.ref)
          previousGenerated = yield* deployments.resolveGenerated({
            config: generatedConfig,
            stateRoot: input.stateRoot,
            name: requestedDeployment,
          }).pipe(
            Effect.matchEffect({
              onSuccess: (deployment) => Effect.succeed(deployment),
              onFailure: () => Effect.succeed(undefined),
            }),
          )
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

        const runtimeResult = yield* deployExecution(input, materialized).pipe(
          Effect.catch((error) =>
            materialized
              ? rollbackGeneratedDeployFailure(input, materialized, previousGenerated, error)
              : Effect.fail(error)
          ),
        )
        if (runtimeResult) {
          yield* persistDesiredDeployment(input.stateRoot, runtimeResult.deployment, "running")
        }
        if (input.target === "generated" && replacedGenerated && homeConfig) {
          yield* replaceGeneratedAfterSuccessfulDeploy(
            input,
            replacedGenerated,
            materialized?.name ?? branchSlug(input.deploymentName ?? input.ref),
            homeConfig,
          )
          const inventory = yield* deployments.list({
            config: generatedConfig as RigProjectConfig,
            stateRoot: input.stateRoot,
          })
          yield* persistInventoryEvidence(input.stateRoot, inventory)
        }
        return yield* deployAccepted(input, target, source, runtimeResult?.execution)
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
          return deriveRigRuntimeLogWindow(
            persisted.events.length > 0
              ? persisted
              : {
                ...persisted,
                events,
              },
            {
              project: input.project,
              ...(input.lane ? { lane: input.lane } : {}),
              lines: input.lines,
              includeGlobal: true,
            },
          )
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
          const state = yield* stateStore.load({ stateRoot: input.stateRoot })
          const desiredDeployments = state.desiredDeployments
            .filter((desired) => desired.project === input.project)
            .map((desired) => ({
              name: desired.deployment,
              kind: desired.kind,
              desiredStatus: desired.desiredStatus,
              updatedAt: desired.updatedAt,
            }))
          const projectFailures = state.managedServiceFailures
            .filter((failure) => failure.project === input.project)

          return {
            rigd: yield* health(input.stateRoot),
            deployments: inventory.map((deployment) => ({
              name: deployment.name,
              kind: deployment.kind,
              status: "unknown" as const,
            })),
            desiredDeployments,
            managedServiceFailures: projectFailures.map((failure) => ({
              deployment: failure.deployment,
              component: failure.component,
              occurredAt: failure.occurredAt,
              ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
              ...(failure.stdout ? { stdout: failure.stdout } : {}),
              ...(failure.stderr ? { stderr: failure.stderr } : {}),
              recentCrashCount: recentFailuresForProcess(
                projectFailures,
                {
                  project: input.project,
                  deployment: failure.deployment,
                  component: failure.component,
                  stateRoot: input.stateRoot,
                },
                failure.occurredAt,
              ).length,
            })),
          }
        }),
      lifecycle: (input) =>
        Effect.gen(function* () {
          yield* verifyActionPreflight({
            kind: "lifecycle",
            project: input.project,
            stateRoot: input.stateRoot,
            target: input.lane,
            ...(input.config ? { config: input.config } : {}),
          })
          const runtimeResult = yield* lifecycleExecution(input)
          yield* persistDesiredLifecycle(input, runtimeResult)
          return yield* lifecycleAccepted(input, "cli", runtimeResult?.execution)
        }),
      deploy: (input) =>
        runDeployAction(input, "cli"),
      controlPlaneLifecycle: (input) =>
        Effect.gen(function* () {
          if (!isLifecycleWriteAction(input.action)) {
            return yield* Effect.fail(
              new RigRuntimeError(
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
          yield* verifyActionPreflight({
            kind: "lifecycle",
            project: input.project,
            stateRoot: input.stateRoot,
            target: input.lane,
            ...(input.config ? { config: input.config } : {}),
          })
          const runtimeResult = yield* lifecycleExecution(input)
          yield* persistDesiredLifecycle(input, runtimeResult)
          return yield* lifecycleAccepted(input, "control-plane", runtimeResult?.execution)
        }),
      controlPlaneDeploy: (input) =>
        runDeployAction(input, "control-plane"),
      controlPlaneDestroyGenerated: (input) =>
        Effect.gen(function* () {
          if (input.target !== "generated") {
            return yield* Effect.fail(
              new RigRuntimeError(
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
          const deploymentName = branchSlug(input.deploymentName)
          const target = `generated:${deploymentName}`
          yield* verifyActionPreflight({
            kind: "destroy",
            project: input.project,
            stateRoot: input.stateRoot,
            target,
            deploymentName,
            config: input.config,
          })
          const destroyed = yield* deployments.resolveGenerated({
            config: input.config,
            stateRoot: input.stateRoot,
            name: deploymentName,
          })
          const execution = yield* runtimeExecutor.destroyGenerated({ deployment: destroyed })
          yield* persistDesiredDeployment(input.stateRoot, destroyed, "stopped")
          yield* deployments.destroyGenerated({
            config: input.config,
            stateRoot: input.stateRoot,
            name: deploymentName,
          })
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
          return deriveRigRuntimeWebReadModel(state)
        }),
      webLogs: (input) =>
        Effect.gen(function* () {
          const state = yield* stateStore.load({ stateRoot: input.stateRoot })
          return deriveRigRuntimeLogWindow(state, input)
        }),
    } satisfies RigdService
  }),
)
