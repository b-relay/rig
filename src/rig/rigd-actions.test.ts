import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { decodeRigProjectConfig, type RigProjectConfig } from "./config.js"
import { RigConfigEditorLive, RigConfigFileStoreLive } from "./config-editor.js"
import { RigControlPlane, RigDefaultControlPlaneLive } from "./control-plane.js"
import { evaluateRigPreflight } from "./doctor.js"
import {
  RigDeploymentManager,
  RigDeploymentManagerLive,
  RigDeploymentStore,
  type RigDeploymentRecord,
  type RigDeploymentStoreService,
} from "./deployments.js"
import { RigRuntimeError } from "./errors.js"
import { RigHomeConfigStore, rigHomeConfigDefaults, type RigHomeConfig } from "./home-config.js"
import { RigProviderContractsLive, RigProviderRegistryLive } from "./provider-contracts.js"
import { deriveRigdActionPreflightChecks, RigdActionPreflight, RigdActionPreflightLive } from "./rigd-actions.js"
import { Rigd, RigdLive, type RigdService } from "./rigd.js"
import { RigFileRigdStateStoreLive, RigdStateStore } from "./rigd-state.js"
import {
  RigRuntimeExecutor,
  RigRuntimeExecutorLive,
  type RigRuntimeDeployExecutionInput,
  type RigRuntimeDestroyGeneratedExecutionInput,
  type RigRuntimeExecutionResult,
  type RigRuntimeLifecycleExecutionInput,
} from "./runtime-executor.js"
import { RigLogger, RigRuntimeLive } from "./services.js"

class MemoryDeploymentStore implements RigDeploymentStoreService {
  readonly records = new Map<string, RigDeploymentRecord[]>()

  read(project: string, _stateRoot: string) {
    return Effect.succeed(this.records.get(project) ?? [])
  }

  write(project: string, _stateRoot: string, records: readonly RigDeploymentRecord[]) {
    this.records.set(project, [...records])
    return Effect.void
  }

  ensureState(_record: RigDeploymentRecord) {
    return Effect.void
  }

  removeState(_record: RigDeploymentRecord) {
    return Effect.void
  }
}

class CaptureRigLogger {
  info() {
    return Effect.void
  }

  error() {
    return Effect.void
  }
}

class CaptureRuntimeExecutor {
  readonly lifecycleCalls: RigRuntimeLifecycleExecutionInput[] = []
  readonly deployCalls: RigRuntimeDeployExecutionInput[] = []
  readonly destroyGeneratedCalls: RigRuntimeDestroyGeneratedExecutionInput[] = []

  constructor(private readonly fail?: "lifecycle" | "deploy" | "destroy") {}

  lifecycle(input: RigRuntimeLifecycleExecutionInput) {
    this.lifecycleCalls.push(input)
    if (this.fail === "lifecycle") {
      return Effect.fail(this.failure("lifecycle", input.deployment.name))
    }
    return Effect.succeed(this.result(input.deployment, [`provider:lifecycle:${input.action}`]))
  }

  deploy(input: RigRuntimeDeployExecutionInput) {
    this.deployCalls.push(input)
    if (this.fail === "deploy") {
      return Effect.fail(this.failure("deploy", input.deployment.name))
    }
    return Effect.succeed(this.result(input.deployment, [`provider:deploy:${input.ref}`]))
  }

  destroyGenerated(input: RigRuntimeDestroyGeneratedExecutionInput) {
    this.destroyGeneratedCalls.push(input)
    if (this.fail === "destroy") {
      return Effect.fail(this.failure("destroy", input.deployment.name))
    }
    return Effect.succeed(this.result(input.deployment, [`provider:destroy:${input.deployment.name}`]))
  }

  private result(
    deployment: RigDeploymentRecord,
    operations: readonly string[],
  ): RigRuntimeExecutionResult {
    return {
      project: deployment.project,
      deployment: deployment.name,
      kind: deployment.kind,
      providerProfile: deployment.providerProfile,
      operations,
      events: operations.map((operation) => ({
        event: "component.log",
        project: deployment.project,
        ...(deployment.kind === "local" || deployment.kind === "live" ? { lane: deployment.kind } : {}),
        deployment: deployment.name,
        component: "web",
        details: {
          action: operation.startsWith("provider:lifecycle")
            ? "up"
            : operation.startsWith("provider:destroy")
              ? "down"
              : "deploy",
          operation,
        },
      })),
    }
  }

  private failure(kind: string, deployment: string) {
    return new RigRuntimeError(
      `Provider-backed ${kind} execution failed for '${deployment}'.`,
      "Fix the selected provider and retry the runtime action.",
      {
        reason: "runtime-execution-failed",
        kind,
        deployment,
      },
    )
  }
}

const projectConfig = (): Effect.Effect<RigProjectConfig> =>
  decodeRigProjectConfig({
    name: "pantry",
    domain: "${subdomain}.preview.b-relay.com",
    components: {
      web: {
        mode: "managed",
        command: "bun run start -- --port ${web.port}",
        port: 3070,
        health: "http://127.0.0.1:${web.port}/health",
      },
    },
    local: {
      components: {
        web: {
          port: 5173,
        },
      },
    },
    deployments: {
      subdomain: "${branchSlug}",
      providerProfile: "stub",
    },
  })

const failingPreflight = Layer.succeed(RigdActionPreflight, {
  verify: (input) =>
    Effect.fail(
      new RigRuntimeError(
        `Preflight rejected ${input.kind} action for '${input.project}'.`,
        "Fix the failed preflight check before retrying the control-plane action.",
        {
          reason: "preflight-failed",
          kind: input.kind,
          target: input.target,
        },
      ),
    ),
})

const failingProvider = Layer.succeed(RigdActionPreflight, {
  verify: (input) =>
    Effect.fail(
      new RigRuntimeError(
        `Provider rejected ${input.kind} action for '${input.project}'.`,
        "Fix the provider capability or runtime connection before retrying the control-plane action.",
        {
          reason: "provider-failure",
          kind: input.kind,
          target: input.target,
        },
      ),
    ),
})

const runWithRigd = async <A>(
  effect: Effect.Effect<
    A,
    unknown,
    Rigd | RigDeploymentManager | RigdStateStore | RigControlPlane
  >,
  options?: {
    readonly preflight?: Layer.Layer<RigdActionPreflight>
    readonly executor?: CaptureRuntimeExecutor
    readonly executorLayer?: Layer.Layer<RigRuntimeExecutor>
    readonly homeConfig?: RigHomeConfig
  },
) => {
  const logger = new CaptureRigLogger()
  const deploymentStore = new MemoryDeploymentStore()
  const executor = options?.executor ?? new CaptureRuntimeExecutor()
  const executorLive = options?.executorLayer ?? Layer.succeed(RigRuntimeExecutor, executor)
  const deploymentManagerLive = Layer.provide(
    RigDeploymentManagerLive,
    Layer.succeed(RigDeploymentStore, deploymentStore),
  )
  const preflightLive = options?.preflight ?? RigdActionPreflightLive
  const rigdDependencies = Layer.mergeAll(
    RigRuntimeLive,
    deploymentManagerLive,
    Layer.succeed(RigLogger, logger),
    RigProviderRegistryLive("default"),
    RigFileRigdStateStoreLive,
    RigDefaultControlPlaneLive,
    preflightLive,
    Layer.succeed(RigHomeConfigStore, {
      read: () => Effect.succeed(options?.homeConfig ?? rigHomeConfigDefaults),
      write: () => Effect.void,
    }),
    executorLive,
    Layer.provide(RigConfigEditorLive, RigConfigFileStoreLive),
  )
  const layer = Layer.mergeAll(
    RigRuntimeLive,
    Layer.succeed(RigLogger, logger),
    deploymentManagerLive,
    RigProviderRegistryLive("default"),
    RigFileRigdStateStoreLive,
    RigDefaultControlPlaneLive,
    preflightLive,
    Layer.succeed(RigHomeConfigStore, {
      read: () => Effect.succeed(options?.homeConfig ?? rigHomeConfigDefaults),
      write: () => Effect.void,
    }),
    executorLive,
    Layer.provide(RigConfigEditorLive, RigConfigFileStoreLive),
    Layer.provide(RigdLive, rigdDependencies),
  )

  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

describe("GIVEN control-plane write actions WHEN routed through rigd THEN CLI-visible state stays consistent", () => {
  test("GIVEN CLI and control-plane lifecycle actions WHEN accepted THEN durable receipts and logs share the same runtime path", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          const cli = yield* rigd.lifecycle({
            action: "up",
            project: "pantry",
            lane: "local",
            stateRoot,
          })
          const web = yield* rigd.controlPlaneLifecycle({
            action: "up",
            project: "pantry",
            lane: "local",
            stateRoot,
          })
          const logs = yield* rigd.logs({ project: "pantry", stateRoot, lines: 10 })
          const persisted = yield* store.load({ stateRoot })
          return { cli, web, logs, persisted }
        }),
      )

      expect(result.cli).toMatchObject({ kind: "lifecycle", target: "local", accepted: true })
      expect(result.web).toMatchObject({ kind: "lifecycle", target: "local", accepted: true })
      expect(result.logs.map((entry) => entry.event)).toEqual([
        "rigd.lifecycle.accepted",
        "rigd.lifecycle.accepted",
      ])
      expect(result.persisted.receipts.map((receipt) => `${receipt.kind}:${receipt.target}`)).toEqual([
        "lifecycle:local",
        "lifecycle:local",
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN config-backed lifecycle and deploy actions WHEN accepted THEN provider executor runs before receipts persist", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const executor = new CaptureRuntimeExecutor()
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          const lifecycle = yield* rigd.controlPlaneLifecycle({
            action: "up",
            project: "pantry",
            lane: "local",
            stateRoot,
            config,
          })
          const liveDeploy = yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "live",
            ref: "main",
            stateRoot,
            config,
          })
          const generatedDeploy = yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "generated",
            ref: "feature/provider-backed",
            stateRoot,
            config,
          })
          const componentLogs = yield* rigd.webLogs({
            stateRoot,
            project: "pantry",
            lane: "local",
            component: "web",
            lines: 10,
          })
          const persisted = yield* store.load({ stateRoot })
          return { lifecycle, liveDeploy, generatedDeploy, componentLogs, persisted }
        }),
        { executor },
      )

      expect(result.lifecycle).toMatchObject({ kind: "lifecycle", target: "local", accepted: true })
      expect(result.liveDeploy).toMatchObject({ kind: "deploy", target: "live", accepted: true })
      expect(result.generatedDeploy).toMatchObject({
        kind: "deploy",
        target: "generated:feature-provider-backed",
        accepted: true,
      })
      expect(executor.lifecycleCalls.map((call) => `${call.action}:${call.deployment.kind}:${call.deployment.name}`)).toEqual([
        "up:local:local",
      ])
      expect(executor.deployCalls.map((call) => `${call.ref}:${call.deployment.kind}:${call.deployment.name}`)).toEqual([
        "main:live:live",
        "feature/provider-backed:generated:feature-provider-backed",
      ])
      expect(result.persisted.events.map((event) => event.details)).toEqual([
        expect.objectContaining({
          action: "up",
          operation: "provider:lifecycle:up",
        }),
        expect.objectContaining({
          execution: expect.objectContaining({
            operations: ["provider:lifecycle:up"],
          }),
        }),
        expect.objectContaining({
          action: "deploy",
          operation: "provider:deploy:main",
        }),
        expect.objectContaining({
          execution: expect.objectContaining({
            operations: ["provider:deploy:main"],
          }),
        }),
        expect.objectContaining({
          action: "deploy",
          operation: "provider:deploy:feature/provider-backed",
        }),
        expect.objectContaining({
          execution: expect.objectContaining({
            operations: ["provider:deploy:feature/provider-backed"],
          }),
        }),
      ])
      expect(result.componentLogs).toEqual([
        expect.objectContaining({
          event: "component.log",
          project: "pantry",
          lane: "local",
          deployment: "local",
          component: "web",
          details: {
            action: "up",
            operation: "provider:lifecycle:up",
          },
        }),
      ])
      expect(result.persisted.receipts).toHaveLength(3)
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN a config-backed lifecycle up WHEN rigd restarts THEN desired running deployments are reconciled", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-reconcile-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const firstExecutor = new CaptureRuntimeExecutor()
      const firstRun = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          yield* rigd.controlPlaneLifecycle({
            action: "up",
            project: "pantry",
            lane: "local",
            stateRoot,
            config,
          })
          return yield* store.load({ stateRoot })
        }),
        { executor: firstExecutor },
      )

      const restartExecutor = new CaptureRuntimeExecutor()
      const restarted = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          yield* rigd.start({ stateRoot })
          return yield* store.load({ stateRoot })
        }),
        { executor: restartExecutor },
      )

      expect(firstRun.desiredDeployments).toEqual([
        expect.objectContaining({
          project: "pantry",
          deployment: "local",
          kind: "local",
          desiredStatus: "running",
        }),
      ])
      expect(restartExecutor.lifecycleCalls.map((call) => `${call.action}:${call.deployment.kind}:${call.deployment.name}`)).toEqual([
        "up:local:local",
      ])
      expect(restarted.events.map((event) => event.event)).toContain("rigd.reconcile.deployment-started")
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN a config-backed lifecycle down WHEN persisted THEN restart reconciliation skips the stopped deployment", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-reconcile-stopped-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          yield* rigd.controlPlaneLifecycle({
            action: "up",
            project: "pantry",
            lane: "local",
            stateRoot,
            config,
          })
          return yield* rigd.controlPlaneLifecycle({
            action: "down",
            project: "pantry",
            lane: "local",
            stateRoot,
            config,
          })
        }),
      )

      const restartExecutor = new CaptureRuntimeExecutor()
      const restarted = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          yield* rigd.start({ stateRoot })
          return yield* store.load({ stateRoot })
        }),
        { executor: restartExecutor },
      )

      expect(restarted.desiredDeployments).toEqual([
        expect.objectContaining({
          project: "pantry",
          deployment: "local",
          kind: "local",
          desiredStatus: "stopped",
        }),
      ])
      expect(restartExecutor.lifecycleCalls).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN a config-backed live deploy WHEN rigd restarts THEN the deployed live runtime is reconciled", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-reconcile-deploy-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const firstExecutor = new CaptureRuntimeExecutor()
      const firstRun = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "live",
            ref: "main",
            stateRoot,
            config,
          })
          return yield* store.load({ stateRoot })
        }),
        { executor: firstExecutor },
      )

      const restartExecutor = new CaptureRuntimeExecutor()
      await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          return yield* rigd.start({ stateRoot })
        }),
        { executor: restartExecutor },
      )

      expect(firstExecutor.deployCalls.map((call) => `${call.ref}:${call.deployment.kind}:${call.deployment.name}`)).toEqual([
        "main:live:live",
      ])
      expect(firstRun.desiredDeployments).toEqual([
        expect.objectContaining({
          project: "pantry",
          deployment: "live",
          kind: "live",
          desiredStatus: "running",
        }),
      ])
      expect(restartExecutor.lifecycleCalls.map((call) => `${call.action}:${call.deployment.kind}:${call.deployment.name}`)).toEqual([
        "up:live:live",
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN a desired-running process exits WHEN crash policy allows restart THEN rigd records the crash and restarts it", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-crash-restart-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const executor = new CaptureRuntimeExecutor()
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          yield* rigd.controlPlaneLifecycle({
            action: "up",
            project: "pantry",
            lane: "local",
            stateRoot,
            config,
          })
          const exit = yield* rigd.managedProcessExited({
            project: "pantry",
            deployment: "local",
            component: "web",
            stateRoot,
            exitCode: 1,
            occurredAt: "2026-04-27T12:00:00.000Z",
            stderr: "server crashed",
          })
          const persisted = yield* store.load({ stateRoot })
          return { exit, persisted }
        }),
        { executor },
      )

      expect(result.exit).toEqual({
        action: "restarted",
        project: "pantry",
        deployment: "local",
        component: "web",
        recentCrashCount: 1,
      })
      expect(executor.lifecycleCalls.map((call) => `${call.action}:${call.deployment.kind}:${call.deployment.name}`)).toEqual([
        "up:local:local",
        "up:local:local",
      ])
      expect(result.persisted.managedServiceFailures).toEqual([
        expect.objectContaining({
          project: "pantry",
          deployment: "local",
          component: "web",
          exitCode: 1,
          stderr: "server crashed",
        }),
      ])
      expect(result.persisted.events.map((event) => event.event)).toContain("rigd.process.restarted")
      expect(result.persisted.events).toContainEqual(expect.objectContaining({
        event: "rigd.process.restarted",
        component: "web",
        details: expect.objectContaining({
          reason: "managed-process-exited",
          policy: "restart-with-backoff",
          nextAction: "restart",
          failureOccurredAt: "2026-04-27T12:00:00.000Z",
          retryAttempt: 1,
          recentCrashCount: 1,
          maxRestarts: 2,
          remainingRestarts: 1,
          restartBudgetExhausted: false,
          desiredStatus: "running",
          backoffWindowMs: 300000,
          backoffWindowStartedAt: "2026-04-27T12:00:00.000Z",
          backoffWindowEndsAt: "2026-04-27T12:05:00.000Z",
          exitCode: 1,
          stderr: "server crashed",
        }),
      }))
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN repeated process exits inside the backoff window WHEN retry budget is exhausted THEN rigd leaves it failed", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-crash-failed-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const executor = new CaptureRuntimeExecutor()
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          yield* rigd.controlPlaneLifecycle({
            action: "up",
            project: "pantry",
            lane: "local",
            stateRoot,
            config,
          })
          yield* rigd.managedProcessExited({
            project: "pantry",
            deployment: "local",
            component: "web",
            stateRoot,
            exitCode: 1,
            occurredAt: "2026-04-27T12:00:00.000Z",
          })
          yield* rigd.managedProcessExited({
            project: "pantry",
            deployment: "local",
            component: "web",
            stateRoot,
            exitCode: 1,
            occurredAt: "2026-04-27T12:01:00.000Z",
          })
          const exhausted = yield* rigd.managedProcessExited({
            project: "pantry",
            deployment: "local",
            component: "web",
            stateRoot,
            exitCode: 1,
            occurredAt: "2026-04-27T12:02:00.000Z",
          })
          const healthState = yield* rigd.healthState({
            project: "pantry",
            stateRoot,
            config,
          })
          const persisted = yield* store.load({ stateRoot })
          return { exhausted, healthState, persisted }
        }),
        { executor },
      )

      expect(result.exhausted).toEqual({
        action: "failed",
        project: "pantry",
        deployment: "local",
        component: "web",
        recentCrashCount: 3,
      })
      expect(executor.lifecycleCalls.map((call) => `${call.action}:${call.deployment.kind}:${call.deployment.name}`)).toEqual([
        "up:local:local",
        "up:local:local",
        "up:local:local",
      ])
      expect(result.persisted.desiredDeployments).toEqual([
        expect.objectContaining({
          project: "pantry",
          deployment: "local",
          desiredStatus: "failed",
        }),
      ])
      expect(result.healthState.desiredDeployments).toContainEqual(expect.objectContaining({
        name: "local",
        kind: "local",
        desiredStatus: "failed",
      }))
      expect(result.healthState.managedServiceFailures).toContainEqual(expect.objectContaining({
        deployment: "local",
        component: "web",
        occurredAt: "2026-04-27T12:02:00.000Z",
        exitCode: 1,
        recentCrashCount: 3,
      }))
      expect(result.persisted.events.map((event) => event.event)).toContain("rigd.process.failed")
      expect(result.persisted.events).toContainEqual(expect.objectContaining({
        event: "rigd.process.failed",
        component: "web",
        details: expect.objectContaining({
          reason: "restart-budget-exhausted",
          policy: "restart-with-backoff",
          nextAction: "leave-failed",
          finalDesiredStatus: "failed",
          failureOccurredAt: "2026-04-27T12:02:00.000Z",
          retryAttempt: 3,
          recentCrashCount: 3,
          maxRestarts: 2,
          remainingRestarts: 0,
          restartBudgetExhausted: true,
          backoffWindowMs: 300000,
          backoffWindowStartedAt: "2026-04-27T12:00:00.000Z",
          backoffWindowEndsAt: "2026-04-27T12:05:00.000Z",
          exitCode: 1,
        }),
      }))
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN real rigd-supervised process exits after lifecycle up WHEN watcher observes it THEN rigd records the failure", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-real-process-watch-"))

    try {
      const config = await Effect.runPromise(decodeRigProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "sleep 0.05; printf watched >&2; exit 7",
            port: 3070,
          },
        },
      }))

      const persisted = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          yield* rigd.controlPlaneLifecycle({
            action: "up",
            project: "pantry",
            lane: "local",
            stateRoot,
            config,
          })

          for (let attempt = 0; attempt < 80; attempt += 1) {
            const state = yield* store.load({ stateRoot })
            if (
              state.managedServiceFailures.length > 0 &&
              state.events.some((event) => event.event === "rigd.process.restarted")
            ) {
              return state
            }
            yield* Effect.sleep("25 millis")
          }

          return yield* Effect.fail(new RigRuntimeError(
            "Timed out waiting for rigd to observe the managed process exit.",
            "Ensure the rigd process supervisor watcher is attached to started process handles.",
          ))
        }),
        {
          executorLayer: Layer.provide(RigRuntimeExecutorLive, RigProviderContractsLive("default")),
        },
      )

      expect(persisted.managedServiceFailures).toContainEqual(expect.objectContaining({
        project: "pantry",
        deployment: "local",
        component: "web",
        exitCode: 7,
        stderr: "watched",
      }))
      expect(persisted.events.map((event) => event.event)).toContain("rigd.process.restarted")
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN provider-backed execution fails WHEN action is requested THEN no receipt or log is persisted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          const error = yield* Effect.flip(
            rigd.controlPlaneLifecycle({
              action: "up",
              project: "pantry",
              lane: "local",
              stateRoot,
              config,
            }),
          )
          const persisted = yield* store.load({ stateRoot })
          return { error, persisted }
        }),
        { executor: new CaptureRuntimeExecutor("lifecycle") },
      )

      expect(result.error).toMatchObject({
        _tag: "RigRuntimeError",
        details: { reason: "runtime-execution-failed", kind: "lifecycle", deployment: "local" },
      })
      expect(result.persisted.receipts).toEqual([])
      expect(result.persisted.events).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN control-plane deploy actions WHEN live and generated targets are accepted THEN receipts inventory logs and envelopes are web-ready", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const controlPlane = yield* RigControlPlane
          const live = yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "live",
            ref: "main",
            stateRoot,
          })
          const generated = yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "generated",
            ref: "feature/web-actions",
            stateRoot,
            config,
          })
          const model = yield* rigd.webReadModel({ stateRoot })
          const logs = yield* rigd.webLogs({ stateRoot, project: "pantry", lines: 10 })
          const envelope = yield* controlPlane.serializeReceipt(generated)
          return { live, generated, model, logs, envelope }
        }),
      )

      expect(result.live).toMatchObject({ kind: "deploy", target: "live", accepted: true })
      expect(result.generated).toMatchObject({
        kind: "deploy",
        target: "generated:feature-web-actions",
        accepted: true,
      })
      expect(result.model.deployments.map((deployment) => `${deployment.kind}:${deployment.name}`)).toEqual([
        "local:local",
        "live:live",
        "generated:feature-web-actions",
      ])
      expect(result.logs.map((entry) => entry.event)).toEqual([
        "rigd.deploy.accepted",
        "component.log",
        "rigd.deploy.accepted",
      ])
      expect(result.envelope).toMatchObject({
        type: "receipt",
        version: 1,
        payload: {
          kind: "deploy",
          target: "generated:feature-web-actions",
        },
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN CLI and control-plane generated deploys WHEN cap is reached THEN both use the same rigd replacement path", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const cliAccepted = yield* rigd.deploy({
            project: "pantry",
            target: "generated",
            ref: "feature/cli",
            stateRoot,
            config,
          })
          const controlPlaneAccepted = yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "generated",
            ref: "feature/web",
            stateRoot,
            config,
          })
          const model = yield* rigd.webReadModel({ stateRoot })
          const logs = yield* rigd.webLogs({ stateRoot, project: "pantry", lines: 20 })
          return { cliAccepted, controlPlaneAccepted, model, logs }
        }),
        {
          homeConfig: {
            ...rigHomeConfigDefaults,
            deploy: {
              ...rigHomeConfigDefaults.deploy,
              generated: {
                maxActive: 1,
                replacePolicy: "oldest",
              },
            },
          },
        },
      )

      expect(result.cliAccepted).toMatchObject({
        kind: "deploy",
        target: "generated:feature-cli",
        accepted: true,
      })
      expect(result.controlPlaneAccepted).toMatchObject({
        kind: "deploy",
        target: "generated:feature-web",
        accepted: true,
      })
      expect(result.model.deployments.map((deployment) => `${deployment.kind}:${deployment.name}`).sort()).toEqual([
        "generated:feature-web",
        "live:live",
        "local:local",
      ])
      expect(result.logs).toContainEqual(expect.objectContaining({
        event: "rigd.generated.cap-replaced",
        deployment: "feature-cli",
        details: expect.objectContaining({
          requestedDeployment: "feature-web",
          replacedDeployment: "feature-cli",
        }),
      }))
      expect(result.logs.map((entry) => entry.event).filter((event) => event === "rigd.deploy.accepted")).toHaveLength(2)
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN a generated deployment WHEN destroy is accepted THEN generated state is removed and local or live cannot be targeted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "generated",
            ref: "feature/remove-me",
            stateRoot,
            config,
          })
          const invalid = yield* Effect.flip(
            rigd.controlPlaneDestroyGenerated({
              project: "pantry",
              target: "live",
              deploymentName: "live",
              stateRoot,
              config,
            }),
          )
          const destroyed = yield* rigd.controlPlaneDestroyGenerated({
            project: "pantry",
            target: "generated",
            deploymentName: "feature-remove-me",
            stateRoot,
            config,
          })
          const model = yield* rigd.webReadModel({ stateRoot })
          const logs = yield* rigd.webLogs({ stateRoot, project: "pantry", lines: 10 })
          return { invalid, destroyed, model, logs }
        }),
      )

      expect(result.invalid).toMatchObject({
        _tag: "RigRuntimeError",
        details: { reason: "invalid-destroy-target", target: "live" },
      })
      expect(result.destroyed).toMatchObject({
        kind: "destroy",
        target: "generated:feature-remove-me",
        accepted: true,
      })
      expect(result.model.deployments.map((deployment) => `${deployment.kind}:${deployment.name}`)).toEqual([
        "local:local",
        "live:live",
      ])
      expect(result.logs.map((entry) => entry.event)).toEqual([
        "component.log",
        "rigd.deploy.accepted",
        "component.log",
        "rigd.generated.destroy.accepted",
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN generated deployment cap reject policy WHEN cap is reached THEN rigd rejects a new generated deploy", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "generated",
            ref: "feature/one",
            stateRoot,
            config,
          })
          const rejected = yield* Effect.flip(
            rigd.controlPlaneDeploy({
              project: "pantry",
              target: "generated",
              ref: "feature/two",
              stateRoot,
              config,
            }),
          )
          const model = yield* rigd.webReadModel({ stateRoot })
          return { rejected, model }
        }),
        {
          homeConfig: {
            ...rigHomeConfigDefaults,
            deploy: {
              ...rigHomeConfigDefaults.deploy,
              generated: {
                maxActive: 1,
                replacePolicy: "reject",
              },
            },
          },
        },
      )

      expect(result.rejected).toMatchObject({
        _tag: "RigRuntimeError",
        details: {
          reason: "generated-deployment-cap-reached",
          maxActive: 1,
          replacePolicy: "reject",
          requestedDeployment: "feature-two",
          activeDeployments: ["feature-one"],
        },
      })
      expect(result.model.deployments.map((deployment) => `${deployment.kind}:${deployment.name}`)).toEqual([
        "local:local",
        "live:live",
        "generated:feature-one",
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN generated deployment cap oldest policy WHEN cap is reached THEN rigd replaces the oldest generated deploy", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "generated",
            ref: "z-old",
            stateRoot,
            config,
          })
          yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "generated",
            ref: "m-middle",
            stateRoot,
            config,
          })
          const accepted = yield* rigd.controlPlaneDeploy({
            project: "pantry",
            target: "generated",
            ref: "a-new",
            stateRoot,
            config,
          })
          const model = yield* rigd.webReadModel({ stateRoot })
          const logs = yield* rigd.webLogs({ stateRoot, project: "pantry", lines: 20 })
          return { accepted, model, logs }
        }),
        {
          homeConfig: {
            ...rigHomeConfigDefaults,
            deploy: {
              ...rigHomeConfigDefaults.deploy,
              generated: {
                maxActive: 2,
                replacePolicy: "oldest",
              },
            },
          },
        },
      )

      expect(result.accepted).toMatchObject({
        kind: "deploy",
        target: "generated:a-new",
        accepted: true,
      })
      expect(result.model.deployments.map((deployment) => `${deployment.kind}:${deployment.name}`).sort()).toEqual([
        "generated:a-new",
        "generated:m-middle",
        "live:live",
        "local:local",
      ])
      expect(result.model.deployments.map((deployment) => deployment.name)).not.toContain("z-old")
      expect(result.logs).toContainEqual(expect.objectContaining({
        event: "rigd.generated.cap-replaced",
        deployment: "z-old",
        details: expect.objectContaining({
          requestedDeployment: "a-new",
          replacedDeployment: "z-old",
        }),
      }))
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN invalid control-plane write targets WHEN routed through rigd THEN tagged validation errors are returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const invalidLifecycle = yield* Effect.flip(
            rigd.controlPlaneLifecycle({
              action: "status",
              project: "pantry",
              lane: "local",
              stateRoot,
            } as Parameters<RigdService["controlPlaneLifecycle"]>[0]),
          )
          const invalidDeploy = yield* Effect.flip(
            rigd.controlPlaneDeploy({
              project: "pantry",
              target: "local",
              ref: "main",
              stateRoot,
            } as Parameters<RigdService["controlPlaneDeploy"]>[0]),
          )
          return { invalidLifecycle, invalidDeploy }
        }),
      )

      expect(result.invalidLifecycle).toMatchObject({
        _tag: "RigRuntimeError",
        details: { reason: "invalid-lifecycle-action", action: "status" },
      })
      expect(result.invalidDeploy).toMatchObject({
        _tag: "RigRuntimeError",
        details: { reason: "invalid-deploy-target", target: "local" },
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN stale generated state WHEN teardown is requested THEN no destroy receipt is persisted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          const error = yield* Effect.flip(
            rigd.controlPlaneDestroyGenerated({
              project: "pantry",
              target: "generated",
              deploymentName: "missing",
              stateRoot,
              config,
            }),
          )
          const persisted = yield* store.load({ stateRoot })
          return { error, persisted }
        }),
      )

      expect(result.error).toMatchObject({
        _tag: "RigRuntimeError",
        details: { project: "pantry", deployment: "missing" },
      })
      expect(result.persisted.receipts).toEqual([])
      expect(result.persisted.events).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN preflight rejects a control-plane action WHEN routed through rigd THEN no receipt or log is persisted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          const error = yield* Effect.flip(
            rigd.controlPlaneDeploy({
              project: "pantry",
              target: "live",
              ref: "main",
              stateRoot,
            }),
          )
          const persisted = yield* store.load({ stateRoot })
          return { error, persisted }
        }),
        { preflight: failingPreflight },
      )

      expect(result.error).toMatchObject({
        _tag: "RigRuntimeError",
        details: { reason: "preflight-failed", kind: "deploy", target: "live" },
      })
      expect(result.persisted.receipts).toEqual([])
      expect(result.persisted.events).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN persisted port conflict WHEN deploy is requested THEN real preflight blocks before runtime mutation", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const executor = new CaptureRuntimeExecutor()
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          yield* store.writePortReservations({
            stateRoot,
            reservations: [
              {
                project: "other",
                deployment: "live",
                component: "web",
                port: 3070,
                owner: "rigd",
                status: "reserved",
                observedAt: "2026-05-01T00:00:00.000Z",
              },
            ],
          })
          yield* store.writeDesiredDeployment({
            stateRoot,
            desired: {
              project: "other",
              deployment: "live",
              kind: "live",
              desiredStatus: "running",
              updatedAt: "2026-05-01T00:00:00.000Z",
              providerProfile: "stub",
              record: {} as RigDeploymentRecord,
            },
          })
          const error = yield* Effect.flip(
            rigd.controlPlaneDeploy({
              project: "pantry",
              target: "live",
              ref: "main",
              stateRoot,
              config,
            }),
          )
          const persisted = yield* store.load({ stateRoot })
          return { error, persisted }
        }),
        { executor },
      )

      expect(result.error).toMatchObject({
        _tag: "RigRuntimeError",
        message: "Preflight failed for deploy action 'live'.",
        hint: "Resolve the reported preflight failures before retrying the runtime action.",
        details: {
          reason: "preflight-failed",
          kind: "deploy",
          target: "live",
          failures: [
            expect.objectContaining({
              category: "ports",
              component: "web",
              reason: "port-conflict",
              details: expect.objectContaining({
                port: 3070,
                conflictingProject: "other",
                conflictingDeployment: "live",
              }),
            }),
          ],
        },
      })
      expect(executor.deployCalls).toEqual([])
      expect(result.persisted.receipts).toEqual([])
      expect(result.persisted.events).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN new generated deploy port conflict WHEN requested THEN preflight blocks before generated inventory is written", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(
        decodeRigProjectConfig({
          name: "pantry",
          components: {
            web: {
              mode: "managed",
              command: "bun run start -- --port ${web.port}",
              port: 3070,
            },
          },
          local: {
            components: {
              web: {
                port: 5173,
              },
            },
          },
          deployments: {
            providerProfile: "stub",
            components: {
              web: {
                port: 3070,
              },
            },
          },
        }),
      )
      const executor = new CaptureRuntimeExecutor()
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const store = yield* RigdStateStore
          const deployments = yield* RigDeploymentManager
          const preview = yield* deployments.previewGenerated({
            config,
            stateRoot,
            branch: "feature/conflict",
            name: "feature-conflict",
          })
          yield* store.writePortReservations({
            stateRoot,
            reservations: [
              {
                project: "other",
                deployment: "live",
                component: "web",
                port: preview.assignedPorts.web as number,
                owner: "rigd",
                status: "reserved",
                observedAt: "2026-05-01T00:00:00.000Z",
              },
            ],
          })
          yield* store.writeDesiredDeployment({
            stateRoot,
            desired: {
              project: "other",
              deployment: "live",
              kind: "live",
              desiredStatus: "running",
              updatedAt: "2026-05-01T00:00:00.000Z",
              providerProfile: "stub",
              record: {} as RigDeploymentRecord,
            },
          })
          const error = yield* Effect.flip(
            rigd.controlPlaneDeploy({
              project: "pantry",
              target: "generated",
              ref: "feature/conflict",
              stateRoot,
              config,
            }),
          )
          const inventory = yield* deployments.list({ config, stateRoot })
          return { error, inventory }
        }),
        { executor },
      )

      expect(result.error).toMatchObject({
        _tag: "RigRuntimeError",
        details: {
          reason: "preflight-failed",
          target: "generated:feature-conflict",
          failures: [
            expect.objectContaining({
              category: "ports",
              component: "web",
              reason: "port-conflict",
            }),
          ],
        },
      })
      expect(executor.deployCalls).toEqual([])
      expect(result.inventory.map((deployment) => `${deployment.kind}:${deployment.name}`)).toEqual([
        "local:local",
        "live:live",
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN runtime plan managed component WHEN preflight derives port evidence THEN legacy environment services are not required", async () => {
    const deployment = {
      project: "pantry",
      kind: "live",
      name: "live",
      providerProfile: "stub",
      assignedPorts: {},
      resolved: {
        providers: {
          processSupervisor: "stub-process-supervisor",
        },
        environment: {
          services: [],
        },
        runtimePlan: {
          components: [
            {
              name: "web",
              kind: "managed",
              command: "bun run start -- --port 3070",
              port: 3070,
              readyTimeout: 30,
            },
          ],
          preparedComponents: [],
        },
      },
    } as unknown as RigDeploymentRecord
    const checks = await Effect.runPromise(
      deriveRigdActionPreflightChecks(
        {
          kind: "deploy",
          project: "pantry",
          stateRoot: "/tmp/rig",
          target: "live",
          config: {} as RigProjectConfig,
        },
        {
          deployments: {
            list: () => Effect.succeed([deployment]),
            previewGenerated: () => Effect.die("unused"),
            materializeGenerated: () => Effect.die("unused"),
            destroyGenerated: () => Effect.die("unused"),
          },
          stateStore: {
            load: () =>
              Effect.succeed({
                version: 1,
                events: [],
                receipts: [],
                healthSummaries: [],
                providerObservations: [],
                portReservations: [
                  {
                    project: "other",
                    deployment: "live",
                    component: "web",
                    port: 3070,
                    owner: "rigd" as const,
                    status: "reserved" as const,
                    observedAt: "2026-05-01T00:00:00.000Z",
                  },
                ],
                deploymentSnapshots: [],
                desiredDeployments: [
                  {
                    project: "other",
                    deployment: "live",
                    kind: "live",
                    desiredStatus: "running",
                    updatedAt: "2026-05-01T00:00:00.000Z",
                    providerProfile: "stub",
                    record: {} as RigDeploymentRecord,
                  },
                ],
                managedServiceFailures: [],
              }),
            appendEvent: () => Effect.die("unused"),
            appendReceipt: () => Effect.die("unused"),
            writeHealthSummary: () => Effect.die("unused"),
            writeProviderObservations: () => Effect.die("unused"),
            writePortReservations: () => Effect.die("unused"),
            writeDeploymentSnapshot: () => Effect.die("unused"),
            writeDesiredDeployment: () => Effect.die("unused"),
            appendManagedServiceFailure: () => Effect.die("unused"),
            reconstructMinimum: () => Effect.die("unused"),
          },
          providerRegistry: {
            current: Effect.succeed({
              profile: "stub" as const,
              families: ["process-supervisor"],
              providers: [
                {
                  id: "stub-process-supervisor",
                  family: "process-supervisor",
                  source: "core" as const,
                  displayName: "Stub",
                  capabilities: ["test"],
                },
              ],
            }),
            forProfile: () =>
              Effect.succeed({
                profile: "stub" as const,
                families: ["process-supervisor"],
                providers: [
                  {
                    id: "stub-process-supervisor",
                    family: "process-supervisor",
                    source: "core" as const,
                    displayName: "Stub",
                    capabilities: ["test"],
                  },
                ],
              }),
          },
        },
      ),
    )

    expect(checks.ports).toEqual([
      expect.objectContaining({
        component: "web",
        port: 3070,
        available: false,
      }),
    ])
    expect(evaluateRigPreflight(checks).failures).toContainEqual(expect.objectContaining({
      category: "ports",
      component: "web",
      reason: "port-conflict",
    }))
  })

  test("GIVEN generated deploy preflight fails WHEN routed through rigd THEN generated inventory is not materialized", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const deployments = yield* RigDeploymentManager
          const error = yield* Effect.flip(
            rigd.controlPlaneDeploy({
              project: "pantry",
              target: "generated",
              ref: "feature/rejected",
              stateRoot,
              config,
            }),
          )
          const inventory = yield* deployments.list({ config, stateRoot })
          return { error, inventory }
        }),
        { preflight: failingPreflight },
      )

      expect(result.error).toMatchObject({
        _tag: "RigRuntimeError",
        details: { reason: "preflight-failed", kind: "deploy", target: "generated:feature-rejected" },
      })
      expect(result.inventory.map((deployment) => `${deployment.kind}:${deployment.name}`)).toEqual([
        "local:local",
        "live:live",
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN provider validation rejects a control-plane action WHEN routed through rigd THEN a tagged provider failure is returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-actions-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const error = yield* Effect.flip(
            rigd.controlPlaneLifecycle({
              action: "up",
              project: "pantry",
              lane: "local",
              stateRoot,
            }),
          )
          return error
        }),
        { preflight: failingProvider },
      )

      expect(result).toMatchObject({
        _tag: "RigRuntimeError",
        details: { reason: "provider-failure", kind: "lifecycle", target: "local" },
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
