import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v4"

import type { V2DeploymentRecord } from "./deployments.js"
import {
  V2EventTransportProvider,
  V2HealthCheckerProvider,
  V2PackageManagerProvider,
  V2ProcessSupervisorProvider,
  V2ProviderContractsLive,
  V2ProxyRouterProvider,
  V2ScmProvider,
  V2WorkspaceMaterializerProvider,
} from "./provider-contracts.js"
import {
  V2RuntimeExecutor,
  V2RuntimeExecutorLive,
  type V2RuntimeLifecycleExecutionInput,
} from "./runtime-executor.js"

const deployment = (): V2DeploymentRecord => ({
  project: "pantry",
  kind: "live",
  name: "live",
  branchSlug: "live",
  subdomain: "live",
  workspacePath: "/tmp/rig-v2/workspaces/pantry/live",
  logRoot: "/tmp/rig-v2/logs/pantry/live",
  runtimeRoot: "/tmp/rig-v2/runtime/pantry/live",
  runtimeStatePath: "/tmp/rig-v2/runtime/pantry/live/runtime.json",
  assignedPorts: {
    web: 3070,
    worker: 3071,
  },
  providerProfile: "stub",
  resolved: {
    name: "pantry",
    version: undefined,
    repoPath: "/tmp/rig-v2/workspaces/pantry/live",
    environmentName: "live",
    environment: {
      services: [
        {
          name: "web",
          type: "server",
          command: "bun run start -- --port 3070",
          port: 3070,
          healthCheck: "http://127.0.0.1:3070/health",
        },
        {
          name: "worker",
          type: "server",
          command: "bun run worker",
        },
        {
          name: "tool",
          type: "bin",
          entrypoint: "src/cli.ts",
        },
      ],
      proxy: {
        domain: "live.preview.b-relay.com",
        upstream: "web",
      },
    },
    workspacePath: "/tmp/rig-v2/workspaces/pantry/live",
    providerProfile: "stub",
  },
})

const runWithExecutor = <A>(effect: Effect.Effect<A, unknown, V2RuntimeExecutor>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.provide(V2RuntimeExecutorLive, V2ProviderContractsLive("stub"))),
    ),
  )

const captureProviderLayer = (calls: string[]) => {
  const plugin = (
    id: string,
    family:
      | "process-supervisor"
      | "proxy-router"
      | "scm"
      | "workspace-materializer"
      | "event-transport"
      | "health-checker"
      | "package-manager",
  ) => ({
    id,
    family,
    source: "first-party" as const,
    displayName: id,
    capabilities: ["runtime-operation-test"],
  })

  const record = (operation: string) => {
    calls.push(operation)
    return Effect.succeed(`capture:${operation}`)
  }

  return Layer.mergeAll(
    Layer.succeed(V2WorkspaceMaterializerProvider, {
      family: "workspace-materializer" as const,
      plugin: Effect.succeed(plugin("capture-workspace", "workspace-materializer")),
      resolve: (input: { readonly deployment: V2DeploymentRecord }) =>
        record(`workspace:resolve:${input.deployment.name}`),
      materialize: (input: { readonly deployment: V2DeploymentRecord; readonly ref: string }) =>
        record(`workspace:materialize:${input.deployment.name}:${input.ref}`),
      remove: (input: { readonly deployment: V2DeploymentRecord }) =>
        record(`workspace:remove:${input.deployment.name}`),
    }),
    Layer.succeed(V2ProcessSupervisorProvider, {
      family: "process-supervisor" as const,
      plugin: Effect.succeed(plugin("capture-process", "process-supervisor")),
      up: (input: { readonly service: { readonly name: string } }) =>
        record(`process:up:${input.service.name}`),
      down: (input: { readonly service: { readonly name: string } }) =>
        record(`process:down:${input.service.name}`),
      restart: (input: { readonly service: { readonly name: string } }) =>
        record(`process:restart:${input.service.name}`),
    }),
    Layer.succeed(V2HealthCheckerProvider, {
      family: "health-checker" as const,
      plugin: Effect.succeed(plugin("capture-health", "health-checker")),
      check: (input: { readonly service: { readonly name: string } }) =>
        record(`health:check:${input.service.name}`),
    }),
    Layer.succeed(V2EventTransportProvider, {
      family: "event-transport" as const,
      plugin: Effect.succeed(plugin("capture-event", "event-transport")),
      append: (input: { readonly event: string }) => record(`event:append:${input.event}`),
    }),
    Layer.succeed(V2ScmProvider, {
      family: "scm" as const,
      plugin: Effect.succeed(plugin("capture-scm", "scm")),
      checkout: (input: { readonly ref: string }) => record(`scm:checkout:${input.ref}`),
    }),
    Layer.succeed(V2PackageManagerProvider, {
      family: "package-manager" as const,
      plugin: Effect.succeed(plugin("capture-package", "package-manager")),
      install: (input: { readonly service: { readonly name: string } }) =>
        record(`package:install:${input.service.name}`),
    }),
    Layer.succeed(V2ProxyRouterProvider, {
      family: "proxy-router" as const,
      plugin: Effect.succeed(plugin("capture-proxy", "proxy-router")),
      upsert: (input: { readonly proxy: { readonly upstream: string } }) =>
        record(`proxy:upsert:${input.proxy.upstream}`),
      remove: (input: { readonly proxy: { readonly upstream: string } }) =>
        record(`proxy:remove:${input.proxy.upstream}`),
    }),
  )
}

describe("GIVEN v2 runtime executor WHEN provider-backed operations run THEN provider interfaces are invoked", () => {
  test("GIVEN lifecycle up WHEN executed THEN workspace process health and event providers return ordered operations", async () => {
    const input: V2RuntimeLifecycleExecutionInput = {
      action: "up",
      deployment: deployment(),
    }

    const result = await runWithExecutor(
      Effect.gen(function* () {
        const executor = yield* V2RuntimeExecutor
        return yield* executor.lifecycle(input)
      }),
    )

    expect(result.operations).toEqual([
      "workspace-materializer:stub-workspace-materializer:resolve:/tmp/rig-v2/workspaces/pantry/live",
      "process-supervisor:stub-process-supervisor:up:web",
      "process-supervisor:stub-process-supervisor:up:worker",
      "health-checker:stub-health-checker:check:web",
      "event-transport:stub-event-transport:append:lifecycle:up",
    ])
  })

  test("GIVEN capture providers WHEN lifecycle up runs THEN runtime provider methods are called in order", async () => {
    const calls: string[] = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* V2RuntimeExecutor
        return yield* executor.lifecycle({
          action: "up",
          deployment: deployment(),
        })
      }).pipe(
        Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer(calls))),
      ),
    )

    expect(calls).toEqual([
      "workspace:resolve:live",
      "process:up:web",
      "process:up:worker",
      "health:check:web",
      "event:append:lifecycle:up",
    ])
    expect(result.operations).toEqual([
      "capture:workspace:resolve:live",
      "capture:process:up:web",
      "capture:process:up:worker",
      "capture:health:check:web",
      "capture:event:append:lifecycle:up",
    ])
  })

  test("GIVEN capture providers WHEN deploy runs THEN scm workspace package process health proxy and event methods run", async () => {
    const calls: string[] = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* V2RuntimeExecutor
        return yield* executor.deploy({
          deployment: deployment(),
          ref: "feature/provider-methods",
        })
      }).pipe(
        Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer(calls))),
      ),
    )

    expect(calls).toEqual([
      "scm:checkout:feature/provider-methods",
      "workspace:materialize:live:feature/provider-methods",
      "package:install:tool",
      "process:restart:web",
      "process:restart:worker",
      "health:check:web",
      "proxy:upsert:web",
      "event:append:deploy:feature/provider-methods",
    ])
    expect(result.operations).toEqual([
      "capture:scm:checkout:feature/provider-methods",
      "capture:workspace:materialize:live:feature/provider-methods",
      "capture:package:install:tool",
      "capture:process:restart:web",
      "capture:process:restart:worker",
      "capture:health:check:web",
      "capture:proxy:upsert:web",
      "capture:event:append:deploy:feature/provider-methods",
    ])
  })

  test("GIVEN capture providers WHEN generated destroy runs THEN process proxy workspace and event methods run", async () => {
    const calls: string[] = []
    const generated = {
      ...deployment(),
      kind: "generated" as const,
      name: "feature-provider-methods",
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* V2RuntimeExecutor
        return yield* executor.destroyGenerated({
          deployment: generated,
        })
      }).pipe(
        Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer(calls))),
      ),
    )

    expect(calls).toEqual([
      "process:down:worker",
      "process:down:web",
      "proxy:remove:web",
      "workspace:remove:feature-provider-methods",
      "event:append:destroy:feature-provider-methods",
    ])
    expect(result.operations).toEqual([
      "capture:process:down:worker",
      "capture:process:down:web",
      "capture:proxy:remove:web",
      "capture:workspace:remove:feature-provider-methods",
      "capture:event:append:destroy:feature-provider-methods",
    ])
  })
})
