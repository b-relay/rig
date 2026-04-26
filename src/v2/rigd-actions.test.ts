import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v4"

import { decodeV2ProjectConfig, type V2ProjectConfig } from "./config.js"
import { V2ConfigEditorLive, V2ConfigFileStoreLive } from "./config-editor.js"
import { V2ControlPlane, V2DefaultControlPlaneLive } from "./control-plane.js"
import {
  V2DeploymentManager,
  V2DeploymentManagerLive,
  V2DeploymentStore,
  type V2DeploymentRecord,
  type V2DeploymentStoreService,
} from "./deployments.js"
import { V2RuntimeError } from "./errors.js"
import { V2ProviderRegistryLive } from "./provider-contracts.js"
import { V2RigdActionPreflight, V2RigdActionPreflightLive } from "./rigd-actions.js"
import { V2Rigd, V2RigdLive, type V2RigdService } from "./rigd.js"
import { V2FileRigdStateStoreLive, V2RigdStateStore } from "./rigd-state.js"
import {
  V2RuntimeExecutor,
  type V2RuntimeDeployExecutionInput,
  type V2RuntimeDestroyGeneratedExecutionInput,
  type V2RuntimeExecutionResult,
  type V2RuntimeLifecycleExecutionInput,
} from "./runtime-executor.js"
import { V2Logger, V2RuntimeLive } from "./services.js"

class MemoryDeploymentStore implements V2DeploymentStoreService {
  readonly records = new Map<string, V2DeploymentRecord[]>()

  read(project: string, _stateRoot: string) {
    return Effect.succeed(this.records.get(project) ?? [])
  }

  write(project: string, _stateRoot: string, records: readonly V2DeploymentRecord[]) {
    this.records.set(project, [...records])
    return Effect.void
  }

  ensureState(_record: V2DeploymentRecord) {
    return Effect.void
  }

  removeState(_record: V2DeploymentRecord) {
    return Effect.void
  }
}

class CaptureV2Logger {
  info() {
    return Effect.void
  }

  error() {
    return Effect.void
  }
}

class CaptureRuntimeExecutor {
  readonly lifecycleCalls: V2RuntimeLifecycleExecutionInput[] = []
  readonly deployCalls: V2RuntimeDeployExecutionInput[] = []
  readonly destroyGeneratedCalls: V2RuntimeDestroyGeneratedExecutionInput[] = []

  constructor(private readonly fail?: "lifecycle" | "deploy" | "destroy") {}

  lifecycle(input: V2RuntimeLifecycleExecutionInput) {
    this.lifecycleCalls.push(input)
    if (this.fail === "lifecycle") {
      return Effect.fail(this.failure("lifecycle", input.deployment.name))
    }
    return Effect.succeed(this.result(input.deployment, [`provider:lifecycle:${input.action}`]))
  }

  deploy(input: V2RuntimeDeployExecutionInput) {
    this.deployCalls.push(input)
    if (this.fail === "deploy") {
      return Effect.fail(this.failure("deploy", input.deployment.name))
    }
    return Effect.succeed(this.result(input.deployment, [`provider:deploy:${input.ref}`]))
  }

  destroyGenerated(input: V2RuntimeDestroyGeneratedExecutionInput) {
    this.destroyGeneratedCalls.push(input)
    if (this.fail === "destroy") {
      return Effect.fail(this.failure("destroy", input.deployment.name))
    }
    return Effect.succeed(this.result(input.deployment, [`provider:destroy:${input.deployment.name}`]))
  }

  private result(
    deployment: V2DeploymentRecord,
    operations: readonly string[],
  ): V2RuntimeExecutionResult {
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
    return new V2RuntimeError(
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

const projectConfig = (): Effect.Effect<V2ProjectConfig> =>
  decodeV2ProjectConfig({
    name: "pantry",
    domain: "${subdomain}.preview.b-relay.com",
    components: {
      web: {
        mode: "managed",
        command: "bun run start -- --port ${port.web}",
        port: 3070,
        health: "http://127.0.0.1:${port.web}/health",
      },
    },
    deployments: {
      subdomain: "${branchSlug}",
      providerProfile: "stub",
    },
  })

const failingPreflight = Layer.succeed(V2RigdActionPreflight, {
  verify: (input) =>
    Effect.fail(
      new V2RuntimeError(
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

const failingProvider = Layer.succeed(V2RigdActionPreflight, {
  verify: (input) =>
    Effect.fail(
      new V2RuntimeError(
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
    V2Rigd | V2DeploymentManager | V2RigdStateStore | V2ControlPlane
  >,
  options?: {
    readonly preflight?: Layer.Layer<V2RigdActionPreflight>
    readonly executor?: CaptureRuntimeExecutor
  },
) => {
  const logger = new CaptureV2Logger()
  const deploymentStore = new MemoryDeploymentStore()
  const executor = options?.executor ?? new CaptureRuntimeExecutor()
  const deploymentManagerLive = Layer.provide(
    V2DeploymentManagerLive,
    Layer.succeed(V2DeploymentStore, deploymentStore),
  )
  const preflightLive = options?.preflight ?? V2RigdActionPreflightLive
  const rigdDependencies = Layer.mergeAll(
    V2RuntimeLive,
    deploymentManagerLive,
    Layer.succeed(V2Logger, logger),
    V2ProviderRegistryLive("default"),
    V2FileRigdStateStoreLive,
    V2DefaultControlPlaneLive,
    preflightLive,
    Layer.succeed(V2RuntimeExecutor, executor),
    Layer.provide(V2ConfigEditorLive, V2ConfigFileStoreLive),
  )
  const layer = Layer.mergeAll(
    V2RuntimeLive,
    Layer.succeed(V2Logger, logger),
    deploymentManagerLive,
    V2ProviderRegistryLive("default"),
    V2FileRigdStateStoreLive,
    V2DefaultControlPlaneLive,
    preflightLive,
    Layer.succeed(V2RuntimeExecutor, executor),
    Layer.provide(V2ConfigEditorLive, V2ConfigFileStoreLive),
    Layer.provide(V2RigdLive, rigdDependencies),
  )

  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

describe("GIVEN control-plane write actions WHEN routed through rigd THEN CLI-visible state stays consistent", () => {
  test("GIVEN CLI and control-plane lifecycle actions WHEN accepted THEN durable receipts and logs share the same runtime path", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
          const store = yield* V2RigdStateStore
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
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const executor = new CaptureRuntimeExecutor()
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
          const store = yield* V2RigdStateStore
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

  test("GIVEN provider-backed execution fails WHEN action is requested THEN no receipt or log is persisted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
          const store = yield* V2RigdStateStore
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
        _tag: "V2RuntimeError",
        details: { reason: "runtime-execution-failed", kind: "lifecycle", deployment: "local" },
      })
      expect(result.persisted.receipts).toEqual([])
      expect(result.persisted.events).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN control-plane deploy actions WHEN live and generated targets are accepted THEN receipts inventory logs and envelopes are web-ready", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
          const controlPlane = yield* V2ControlPlane
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

  test("GIVEN a generated deployment WHEN destroy is accepted THEN generated state is removed and local or live cannot be targeted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
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
        _tag: "V2RuntimeError",
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

  test("GIVEN invalid control-plane write targets WHEN routed through rigd THEN tagged validation errors are returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
          const invalidLifecycle = yield* Effect.flip(
            rigd.controlPlaneLifecycle({
              action: "status",
              project: "pantry",
              lane: "local",
              stateRoot,
            } as Parameters<V2RigdService["controlPlaneLifecycle"]>[0]),
          )
          const invalidDeploy = yield* Effect.flip(
            rigd.controlPlaneDeploy({
              project: "pantry",
              target: "local",
              ref: "main",
              stateRoot,
            } as Parameters<V2RigdService["controlPlaneDeploy"]>[0]),
          )
          return { invalidLifecycle, invalidDeploy }
        }),
      )

      expect(result.invalidLifecycle).toMatchObject({
        _tag: "V2RuntimeError",
        details: { reason: "invalid-lifecycle-action", action: "status" },
      })
      expect(result.invalidDeploy).toMatchObject({
        _tag: "V2RuntimeError",
        details: { reason: "invalid-deploy-target", target: "local" },
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN stale generated state WHEN teardown is requested THEN no destroy receipt is persisted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
          const store = yield* V2RigdStateStore
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
        _tag: "V2RuntimeError",
        details: { project: "pantry", deployment: "missing" },
      })
      expect(result.persisted.receipts).toEqual([])
      expect(result.persisted.events).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN preflight rejects a control-plane action WHEN routed through rigd THEN no receipt or log is persisted", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
          const store = yield* V2RigdStateStore
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
        _tag: "V2RuntimeError",
        details: { reason: "preflight-failed", kind: "deploy", target: "live" },
      })
      expect(result.persisted.receipts).toEqual([])
      expect(result.persisted.events).toEqual([])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN generated deploy preflight fails WHEN routed through rigd THEN generated inventory is not materialized", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const config = await Effect.runPromise(projectConfig())
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
          const deployments = yield* V2DeploymentManager
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
        _tag: "V2RuntimeError",
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
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-actions-"))

    try {
      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* V2Rigd
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
        _tag: "V2RuntimeError",
        details: { reason: "provider-failure", kind: "lifecycle", target: "local" },
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
