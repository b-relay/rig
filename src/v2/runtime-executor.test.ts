import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer } from "effect"

import type { V2DeploymentRecord } from "./deployments.js"
import {
  V2EventTransportProvider,
  V2HealthCheckerProvider,
  V2LifecycleHookProvider,
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
  type V2ManagedProcessExitHandlerInput,
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
    providers: {
      processSupervisor: "stub-process-supervisor",
    },
  },
})

const runWithExecutor = <A>(effect: Effect.Effect<A, unknown, V2RuntimeExecutor>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.provide(V2RuntimeExecutorLive, V2ProviderContractsLive("stub"))),
    ),
  )

const captureProviderLayer = (
  calls: string[],
  options: {
    readonly processOutput?: Readonly<Record<string, readonly { readonly stream: "stdout" | "stderr"; readonly line: string }[]>>
    readonly processExits?: Readonly<Record<string, {
      readonly expected: boolean
      readonly exitCode?: number
      readonly stdout?: string
      readonly stderr?: string
    }>>
    readonly healthChecks?: Array<{
      readonly component: string
      readonly timeoutSeconds?: number
    }>
    readonly eventAppends?: Array<{
      readonly event: string
      readonly component?: string
      readonly details?: Readonly<Record<string, unknown>>
    }>
  } = {},
) => {
  const plugin = (
    id: string,
    family:
      | "process-supervisor"
      | "proxy-router"
      | "scm"
      | "workspace-materializer"
      | "event-transport"
      | "health-checker"
      | "lifecycle-hook"
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
  const recordProcess = (operation: string) => {
    calls.push(operation)
    const exit = options.processExits?.[operation]
    return Effect.succeed({
      operation: `capture:${operation}`,
      output: options.processOutput?.[operation] ?? [],
      ...(exit ? { exit: Effect.succeed(exit) } : {}),
    })
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
        recordProcess(`process:up:${input.service.name}`),
      down: (input: { readonly service: { readonly name: string } }) =>
        recordProcess(`process:down:${input.service.name}`),
      restart: (input: { readonly service: { readonly name: string } }) =>
        recordProcess(`process:restart:${input.service.name}`),
    }),
    Layer.succeed(V2HealthCheckerProvider, {
      family: "health-checker" as const,
      plugin: Effect.succeed(plugin("capture-health", "health-checker")),
      check: (input: { readonly service: { readonly name: string }; readonly timeoutSeconds?: number }) => {
        options.healthChecks?.push({
          component: input.service.name,
          ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
        })
        return record(`health:check:${input.service.name}${input.timeoutSeconds === undefined ? "" : `:${input.timeoutSeconds}`}`)
      },
    }),
    Layer.succeed(V2LifecycleHookProvider, {
      family: "lifecycle-hook" as const,
      plugin: Effect.succeed(plugin("capture-hooks", "lifecycle-hook")),
      run: (input: {
        readonly hook: string
        readonly command: string
        readonly service?: { readonly name: string }
      }) =>
        record(`hook:${input.hook}:${input.service?.name ?? "project"}:${input.command}`),
    }),
    Layer.succeed(V2EventTransportProvider, {
      family: "event-transport" as const,
      plugin: Effect.succeed(plugin("capture-event", "event-transport")),
      append: (input: {
        readonly event: string
        readonly component?: string
        readonly details?: Readonly<Record<string, unknown>>
      }) => {
        options.eventAppends?.push({
          event: input.event,
          ...(input.component ? { component: input.component } : {}),
          ...(input.details ? { details: input.details } : {}),
        })
        return record(`event:append:${input.event}${input.component ? `:${input.component}` : ""}`)
      },
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
      "event-transport:stub-event-transport:append:component.log:web",
      "health-checker:stub-health-checker:check:web",
      "event-transport:stub-event-transport:append:component.health:web",
      "process-supervisor:stub-process-supervisor:up:worker",
      "event-transport:stub-event-transport:append:component.log:worker",
      "event-transport:stub-event-transport:append:lifecycle:up",
    ])
    expect(result.events).toEqual([
      expect.objectContaining({
        event: "component.log",
        project: "pantry",
        lane: "live",
        deployment: "live",
        component: "web",
        details: {
          action: "up",
          operation: "process-supervisor:stub-process-supervisor:up:web",
        },
      }),
      expect.objectContaining({
        event: "component.health",
        component: "web",
        details: {
          operation: "health-checker:stub-health-checker:check:web",
        },
      }),
      expect.objectContaining({
        event: "component.log",
        component: "worker",
        details: {
          action: "up",
          operation: "process-supervisor:stub-process-supervisor:up:worker",
        },
      }),
    ])
  })

  test("GIVEN a deployment with a SQLite component WHEN lifecycle up runs THEN its database directory is prepared before processes start", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-sqlite-prepare-"))
    const sqlitePath = join(root, "data", "db.sqlite")
    const calls: string[] = []
    const input: V2RuntimeLifecycleExecutionInput = {
      action: "up",
      deployment: {
        ...deployment(),
        dataRoot: root,
        resolved: {
          ...deployment().resolved,
          preparedComponents: [
            {
              name: "db",
              uses: "sqlite",
              path: sqlitePath,
            },
          ],
          environment: {
            services: [
              {
                name: "api",
                type: "server",
                command: `bun run api -- --sqlite ${sqlitePath}`,
                port: 3080,
              },
            ],
          },
        },
      } as V2DeploymentRecord,
    }

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* V2RuntimeExecutor
          return yield* executor.lifecycle(input)
        }).pipe(Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer(calls)))),
      )

      expect(calls.indexOf("event:append:component.prepare:db")).toBeLessThan(calls.indexOf("process:up:api"))
      expect((await stat(dirname(sqlitePath))).isDirectory()).toBe(true)
      expect(dirname(sqlitePath)).toBe(join(root, "data"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN a deployment with a Convex component WHEN lifecycle up runs THEN its local state directory is prepared before processes start", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-convex-prepare-"))
    const stateDir = join(root, "workspace", ".convex", "local", "default")
    const calls: string[] = []
    const input: V2RuntimeLifecycleExecutionInput = {
      action: "up",
      deployment: {
        ...deployment(),
        dataRoot: root,
        resolved: {
          ...deployment().resolved,
          preparedComponents: [
            {
              name: "convex",
              uses: "convex",
              stateDir,
            },
          ],
          environment: {
            services: [
              {
                name: "convex",
                type: "server",
                command: "bunx convex dev --local --local-cloud-port 3210 --local-site-port 3211",
                port: 3210,
              },
            ],
          },
        },
      } as V2DeploymentRecord,
    }

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* V2RuntimeExecutor
          return yield* executor.lifecycle(input)
        }).pipe(Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer(calls)))),
      )

      expect(calls.indexOf("event:append:component.prepare:convex")).toBeLessThan(calls.indexOf("process:up:convex"))
      expect((await stat(stateDir)).isDirectory()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN a deployment with a Postgres component WHEN lifecycle up runs THEN its data directory is prepared before processes start", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-postgres-prepare-"))
    const dataDir = join(root, "postgres", "postgres")
    const calls: string[] = []
    const input: V2RuntimeLifecycleExecutionInput = {
      action: "up",
      deployment: {
        ...deployment(),
        dataRoot: root,
        resolved: {
          ...deployment().resolved,
          preparedComponents: [
            {
              name: "postgres",
              uses: "postgres",
              dataDir,
            },
          ],
          environment: {
            services: [
              {
                name: "postgres",
                type: "server",
                command: `postgres -D ${dataDir} -h 127.0.0.1 -p 55432`,
                port: 55432,
              },
            ],
          },
        },
      } as V2DeploymentRecord,
    }

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* V2RuntimeExecutor
          return yield* executor.lifecycle(input)
        }).pipe(Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer(calls)))),
      )

      expect(calls.indexOf("event:append:component.prepare:postgres")).toBeLessThan(calls.indexOf("process:up:postgres"))
      expect((await stat(dataDir)).isDirectory()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN lifecycle up starts a watched process WHEN it exits unexpectedly THEN the exit handler receives deployment and component context", async () => {
    let rejectObserved: (cause: unknown) => void = () => undefined
    const observed = new Promise<V2ManagedProcessExitHandlerInput>((resolve, reject) => {
      rejectObserved = reject
      const input: V2RuntimeLifecycleExecutionInput = {
        action: "up",
        deployment: deployment(),
        onManagedProcessExit: (exit) =>
          Effect.sync(() => {
            resolve(exit)
          }),
      }

      Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* V2RuntimeExecutor
          return yield* executor.lifecycle(input)
        }).pipe(
          Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer([], {
            processExits: {
              "process:up:web": {
                expected: false,
                exitCode: 7,
                stdout: "started",
                stderr: "crashed",
              },
            },
          }))),
        ),
      ).catch(reject)
    })

    const exit = await Promise.race([
      observed,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for managed process exit callback.")), 1000)
      }),
    ]).catch((cause) => {
      rejectObserved(cause)
      throw cause
    })
    expect(exit.deployment).toMatchObject({
      project: "pantry",
      name: "live",
    })
    expect(exit.service.name).toBe("web")
    expect(exit.exitCode).toBe(7)
    expect(exit.stdout).toBe("started")
    expect(exit.stderr).toBe("crashed")
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
      "event:append:component.log:web",
      "health:check:web",
      "event:append:component.health:web",
      "process:up:worker",
      "event:append:component.log:worker",
      "event:append:lifecycle:up",
    ])
    expect(result.operations).toEqual([
      "capture:workspace:resolve:live",
      "capture:process:up:web",
      "capture:event:append:component.log:web",
      "capture:health:check:web",
      "capture:event:append:component.health:web",
      "capture:process:up:worker",
      "capture:event:append:component.log:worker",
      "capture:event:append:lifecycle:up",
    ])
  })

  test("GIVEN lifecycle hooks dependencies and health timeouts WHEN up and down run THEN runtime honors the configured lifecycle controls", async () => {
    const calls: string[] = []
    const healthChecks: Array<{ readonly component: string; readonly timeoutSeconds?: number }> = []
    const controlledDeployment = {
      ...deployment(),
      resolved: {
        ...deployment().resolved,
        environment: {
          services: [
            {
              name: "web",
              type: "server",
              command: "bun run web",
              port: 3070,
              healthCheck: "http://127.0.0.1:3070/health",
              readyTimeout: 4,
              dependsOn: ["api"],
              hooks: {
                preStart: "web-pre-start",
                postStart: "web-post-start",
                preStop: "web-pre-stop",
                postStop: "web-post-stop",
              },
            },
            {
              name: "api",
              type: "server",
              command: "bun run api",
              port: 3071,
              healthCheck: "http://127.0.0.1:3071/health",
              readyTimeout: 12,
              hooks: {
                preStart: "api-pre-start",
                postStart: "api-post-start",
                preStop: "api-pre-stop",
                postStop: "api-post-stop",
              },
            },
          ],
        },
        v1Config: {
          name: "pantry",
          version: "0.0.0",
          hooks: {
            preStart: "project-pre-start",
            postStart: "project-post-start",
            preStop: "project-pre-stop",
            postStop: "project-post-stop",
          },
          environments: {
            prod: {
              services: [],
            },
          },
        },
      },
    } as V2DeploymentRecord

    await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* V2RuntimeExecutor
        yield* executor.lifecycle({
          action: "up",
          deployment: controlledDeployment,
        })
        yield* executor.lifecycle({
          action: "down",
          deployment: controlledDeployment,
        })
      }).pipe(
        Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer(calls, { healthChecks }))),
      ),
    )

    expect(healthChecks).toEqual([
      { component: "api", timeoutSeconds: 12 },
      { component: "web", timeoutSeconds: 4 },
    ])
    expect(calls).toEqual([
      "workspace:resolve:live",
      "hook:preStart:project:project-pre-start",
      "hook:preStart:api:api-pre-start",
      "process:up:api",
      "event:append:component.log:api",
      "health:check:api:12",
      "event:append:component.health:api",
      "hook:postStart:api:api-post-start",
      "hook:preStart:web:web-pre-start",
      "process:up:web",
      "event:append:component.log:web",
      "health:check:web:4",
      "event:append:component.health:web",
      "hook:postStart:web:web-post-start",
      "hook:postStart:project:project-post-start",
      "event:append:lifecycle:up",
      "workspace:resolve:live",
      "hook:preStop:project:project-pre-stop",
      "hook:preStop:web:web-pre-stop",
      "process:down:web",
      "event:append:component.log:web",
      "hook:postStop:web:web-post-stop",
      "hook:preStop:api:api-pre-stop",
      "process:down:api",
      "event:append:component.log:api",
      "hook:postStop:api:api-post-stop",
      "hook:postStop:project:project-post-stop",
      "event:append:lifecycle:down",
    ])
  })

  test("GIVEN process provider output WHEN lifecycle up runs THEN stdout and stderr become component log events", async () => {
    const calls: string[] = []
    const eventAppends: Array<{
      readonly event: string
      readonly component?: string
      readonly details?: Readonly<Record<string, unknown>>
    }> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* V2RuntimeExecutor
        return yield* executor.lifecycle({
          action: "up",
          deployment: deployment(),
        })
      }).pipe(
        Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer(calls, {
          eventAppends,
          processOutput: {
            "process:up:web": [
              { stream: "stdout", line: "server listening" },
              { stream: "stderr", line: "warmup warning" },
            ],
          },
        }))),
      ),
    )

    expect(result.events).toContainEqual(expect.objectContaining({
      event: "component.log",
      component: "web",
      details: {
        action: "up",
        operation: "capture:process:up:web",
        stream: "stdout",
        line: "server listening",
      },
    }))
    expect(eventAppends).toContainEqual({
      event: "component.log",
      component: "web",
      details: {
        action: "up",
        operation: "capture:process:up:web",
        stream: "stderr",
        line: "warmup warning",
      },
    })
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
      "event:append:component.install:tool",
      "process:restart:web",
      "event:append:component.log:web",
      "health:check:web",
      "event:append:component.health:web",
      "process:restart:worker",
      "event:append:component.log:worker",
      "proxy:upsert:web",
      "event:append:deploy:feature/provider-methods",
    ])
    expect(result.operations).toEqual([
      "capture:scm:checkout:feature/provider-methods",
      "capture:workspace:materialize:live:feature/provider-methods",
      "capture:package:install:tool",
      "capture:event:append:component.install:tool",
      "capture:process:restart:web",
      "capture:event:append:component.log:web",
      "capture:health:check:web",
      "capture:event:append:component.health:web",
      "capture:process:restart:worker",
      "capture:event:append:component.log:worker",
      "capture:proxy:upsert:web",
      "capture:event:append:deploy:feature/provider-methods",
    ])
  })

  test("GIVEN runtime plan components WHEN deploy runs THEN managed installed health and proxy behavior do not require legacy environment services", async () => {
    const calls: string[] = []
    const runtimePlanDeployment = {
      ...deployment(),
      resolved: {
        ...deployment().resolved,
        environment: {
          services: [],
        },
        v1Config: {
          name: "pantry",
          version: "0.0.0",
          environments: {
            prod: {
              services: [],
            },
          },
        },
        runtimePlan: {
          project: "pantry",
          lane: "live",
          deploymentName: "live",
          branchSlug: "live",
          subdomain: "live",
          workspacePath: "/tmp/rig-v2/workspaces/pantry/live",
          dataRoot: "/tmp/rig-v2/data/pantry/live",
          providerProfile: "stub",
          providers: {
            processSupervisor: "stub-process-supervisor",
          },
          proxy: {
            upstream: "web",
          },
          components: [
            {
              name: "web",
              kind: "managed",
              command: "bun run start -- --port 3070",
              port: 3070,
              health: "http://127.0.0.1:3070/health",
              readyTimeout: 9,
            },
            {
              name: "tool",
              kind: "installed",
              entrypoint: "src/cli.ts",
            },
          ],
          preparedComponents: [],
        },
      },
    } as V2DeploymentRecord

    await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* V2RuntimeExecutor
        return yield* executor.deploy({
          deployment: runtimePlanDeployment,
          ref: "feature/runtime-plan",
        })
      }).pipe(
        Effect.provide(Layer.provide(V2RuntimeExecutorLive, captureProviderLayer(calls))),
      ),
    )

    expect(calls).toEqual([
      "scm:checkout:feature/runtime-plan",
      "workspace:materialize:live:feature/runtime-plan",
      "package:install:tool",
      "event:append:component.install:tool",
      "process:restart:web",
      "event:append:component.log:web",
      "health:check:web:9",
      "event:append:component.health:web",
      "proxy:upsert:web",
      "event:append:deploy:feature/runtime-plan",
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
      "event:append:component.log:worker",
      "process:down:web",
      "event:append:component.log:web",
      "proxy:remove:web",
      "workspace:remove:feature-provider-methods",
      "event:append:destroy:feature-provider-methods",
    ])
    expect(result.operations).toEqual([
      "capture:process:down:worker",
      "capture:event:append:component.log:worker",
      "capture:process:down:web",
      "capture:event:append:component.log:web",
      "capture:proxy:remove:web",
      "capture:workspace:remove:feature-provider-methods",
      "capture:event:append:destroy:feature-provider-methods",
    ])
  })
})
