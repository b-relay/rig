import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server } from "node:http"
import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"
import { Effect, Layer } from "effect"

import type { RigDeploymentRecord } from "./deployments.js"
import {
  RigEventTransportProvider,
  RigHealthCheckerProvider,
  RigLifecycleHookProvider,
  RigPackageManagerProvider,
  RigProcessSupervisorProvider,
  RigProviderContractsLive,
  RigProxyRouterProvider,
  RigScmProvider,
  RigWorkspaceMaterializerProvider,
  type RigProviderPlugin,
} from "./provider-contracts.js"
import {
  caddyProxyRouterProvider,
  createCaddyProxyRouterAdapter,
} from "./providers/caddy-proxy-router.js"
import {
  createNativeHealthCheckerAdapter,
  nativeHealthCheckerProvider,
} from "./providers/native-health-checker.js"
import {
  createPackageJsonScriptsAdapter,
  packageJsonScriptsProvider,
} from "./providers/package-json-scripts.js"
import { rigdProcessSupervisorProvider } from "./providers/rigd-process-supervisor.js"
import {
  createStructuredLogEventTransportAdapter,
  structuredLogEventTransportProvider,
} from "./providers/structured-log-event-transport.js"
import { runPlatformCommand } from "./provider-command-runner.js"
import {
  RigRuntimeExecutor,
  RigRuntimeExecutorLive,
  type RigManagedProcessExitHandlerInput,
  type RigRuntimeLifecycleExecutionInput,
} from "./runtime-executor.js"
import { RigRuntimeError } from "./errors.js"

const execFileAsync = promisify(execFile)

const resolveCaddyPath = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("sh", ["-lc", "command -v caddy"])
    const resolved = stdout.trim()
    return resolved.length > 0 ? resolved : undefined
  } catch {
    return undefined
  }
}

const listenOnRandomPort = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve((server.address() as AddressInfo).port)
    })
  })

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })

const reserveFreePort = async (): Promise<number> => {
  const server = createServer()
  const port = await listenOnRandomPort(server)
  await closeServer(server)
  return port
}

const waitForCaddyRoute = async (input: {
  readonly port: number
  readonly host: string
  readonly expected: string
}): Promise<string> => {
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${input.port}/health`, {
        headers: {
          host: input.host,
        },
      })
      const body = await response.text()
      if (response.ok && body === input.expected) {
        return body
      }
      lastError = new Error(`Unexpected Caddy response ${response.status}: ${body}`)
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const waitForProcessExit = (process: ChildProcessWithoutNullStreams): Promise<void> =>
  process.exitCode !== null || process.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => {
      process.once("exit", () => resolve())
    })

const caddyPath = await resolveCaddyPath()
const testWithCaddy = caddyPath ? test : test.skip

const deployment = (): RigDeploymentRecord => ({
  project: "pantry",
  kind: "live",
  name: "live",
  branchSlug: "live",
  subdomain: "live",
  workspacePath: "/tmp/rig/workspaces/pantry/live",
  logRoot: "/tmp/rig/logs/pantry/live",
  runtimeRoot: "/tmp/rig/runtime/pantry/live",
  runtimeStatePath: "/tmp/rig/runtime/pantry/live/runtime.json",
  assignedPorts: {
    web: 3070,
    worker: 3071,
  },
  providerProfile: "stub",
  resolved: {
    name: "pantry",
    version: undefined,
    repoPath: "/tmp/rig/workspaces/pantry/live",
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
    workspacePath: "/tmp/rig/workspaces/pantry/live",
    providerProfile: "stub",
    providers: {
      processSupervisor: "stub-process-supervisor",
    },
  },
})

const runWithExecutor = <A>(effect: Effect.Effect<A, unknown, RigRuntimeExecutor>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.provide(RigRuntimeExecutorLive, RigProviderContractsLive("stub"))),
    ),
  )

const captureProviderLayer = (
  calls: string[],
  options: {
    readonly failProcess?: readonly string[]
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
    if (options.failProcess?.includes(operation)) {
      return Effect.fail(
        new RigRuntimeError(
          `Captured process operation '${operation}' failed.`,
          "Fix the captured process provider before retrying.",
          { reason: "captured-process-failed", operation },
        ),
      )
    }
    const exit = options.processExits?.[operation]
    return Effect.succeed({
      operation: `capture:${operation}`,
      output: options.processOutput?.[operation] ?? [],
      ...(exit ? { exit: Effect.succeed(exit) } : {}),
    })
  }

  return Layer.mergeAll(
    Layer.succeed(RigWorkspaceMaterializerProvider, {
      family: "workspace-materializer" as const,
      plugin: Effect.succeed(plugin("capture-workspace", "workspace-materializer")),
      resolve: (input: { readonly deployment: RigDeploymentRecord }) =>
        record(`workspace:resolve:${input.deployment.name}`),
      materialize: (input: { readonly deployment: RigDeploymentRecord; readonly ref: string }) =>
        record(`workspace:materialize:${input.deployment.name}:${input.ref}`),
      remove: (input: { readonly deployment: RigDeploymentRecord }) =>
        record(`workspace:remove:${input.deployment.name}`),
    }),
    Layer.succeed(RigProcessSupervisorProvider, {
      family: "process-supervisor" as const,
      plugin: Effect.succeed(plugin("capture-process", "process-supervisor")),
      up: (input: { readonly service: { readonly name: string } }) =>
        recordProcess(`process:up:${input.service.name}`),
      down: (input: { readonly service: { readonly name: string } }) =>
        recordProcess(`process:down:${input.service.name}`),
      restart: (input: { readonly service: { readonly name: string } }) =>
        recordProcess(`process:restart:${input.service.name}`),
    }),
    Layer.succeed(RigHealthCheckerProvider, {
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
    Layer.succeed(RigLifecycleHookProvider, {
      family: "lifecycle-hook" as const,
      plugin: Effect.succeed(plugin("capture-hooks", "lifecycle-hook")),
      run: (input: {
        readonly hook: string
        readonly command: string
        readonly service?: { readonly name: string }
      }) =>
        record(`hook:${input.hook}:${input.service?.name ?? "project"}:${input.command}`),
    }),
    Layer.succeed(RigEventTransportProvider, {
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
    Layer.succeed(RigScmProvider, {
      family: "scm" as const,
      plugin: Effect.succeed(plugin("capture-scm", "scm")),
      checkout: (input: { readonly ref: string }) => record(`scm:checkout:${input.ref}`),
    }),
    Layer.succeed(RigPackageManagerProvider, {
      family: "package-manager" as const,
      plugin: Effect.succeed(plugin("capture-package", "package-manager")),
      install: (input: { readonly service: { readonly name: string } }) =>
        record(`package:install:${input.service.name}`),
    }),
    Layer.succeed(RigProxyRouterProvider, {
      family: "proxy-router" as const,
      plugin: Effect.succeed(plugin("capture-proxy", "proxy-router")),
      upsert: (input: { readonly proxy: { readonly upstream: string } }) =>
        record(`proxy:upsert:${input.proxy.upstream}`),
      remove: (input: { readonly proxy: { readonly upstream: string } }) =>
        record(`proxy:remove:${input.proxy.upstream}`),
    }),
  )
}

const providerPlugin = (
  id: string,
  family: RigProviderPlugin["family"],
): RigProviderPlugin => ({
  id,
  family,
  source: "first-party",
  displayName: id,
  capabilities: ["pantry-dry-run-test"],
})

const pantryDryRunProviderLayer = (
  calls: string[],
  options: {
    readonly caddyfilePath: string
    readonly binRoot: string
  },
) => {
  const caddy = createCaddyProxyRouterAdapter({
    caddyfilePath: options.caddyfilePath,
  }, async () => ({ stdout: "", stderr: "", exitCode: 0 }))
  const packages = createPackageJsonScriptsAdapter({
    binRoot: options.binRoot,
  }, runPlatformCommand)
  const health = createNativeHealthCheckerAdapter(runPlatformCommand)
  const events = createStructuredLogEventTransportAdapter()

  return Layer.mergeAll(
    Layer.succeed(RigWorkspaceMaterializerProvider, {
      family: "workspace-materializer" as const,
      plugin: Effect.succeed(providerPlugin("capture-workspace", "workspace-materializer")),
      resolve: (input: { readonly deployment: RigDeploymentRecord }) => {
        calls.push(`workspace:resolve:${input.deployment.name}`)
        return Effect.succeed(`capture:workspace:resolve:${input.deployment.workspacePath}`)
      },
      materialize: (input: { readonly deployment: RigDeploymentRecord; readonly ref: string }) => {
        calls.push(`workspace:materialize:${input.ref}`)
        return Effect.succeed(`capture:workspace:materialize:${input.deployment.workspacePath}:${input.ref}`)
      },
      remove: (input: { readonly deployment: RigDeploymentRecord }) => {
        calls.push(`workspace:remove:${input.deployment.name}`)
        return Effect.succeed(`capture:workspace:remove:${input.deployment.workspacePath}`)
      },
    }),
    Layer.succeed(RigScmProvider, {
      family: "scm" as const,
      plugin: Effect.succeed(providerPlugin("capture-scm", "scm")),
      checkout: (input: { readonly ref: string }) => {
        calls.push(`scm:checkout:${input.ref}`)
        return Effect.succeed(`capture:scm:checkout:${input.ref}`)
      },
    }),
    Layer.succeed(RigProcessSupervisorProvider, {
      family: "process-supervisor" as const,
      plugin: Effect.succeed(rigdProcessSupervisorProvider),
      up: (input: { readonly service: { readonly name: string } }) => {
        calls.push(`process:up:${input.service.name}`)
        return Effect.succeed({ operation: `capture:process:up:${input.service.name}` })
      },
      down: (input: { readonly service: { readonly name: string } }) => {
        calls.push(`process:down:${input.service.name}`)
        return Effect.succeed({ operation: `capture:process:down:${input.service.name}` })
      },
      restart: (input: { readonly service: { readonly name: string } }) => {
        calls.push(`process:restart:${input.service.name}`)
        return Effect.succeed({ operation: `capture:process:restart:${input.service.name}` })
      },
    }),
    Layer.succeed(RigHealthCheckerProvider, {
      family: "health-checker" as const,
      plugin: Effect.succeed(nativeHealthCheckerProvider),
      check: (input) => {
        calls.push(`health:check:${input.service.name}`)
        return health.check(input, nativeHealthCheckerProvider)
      },
    }),
    Layer.succeed(RigLifecycleHookProvider, {
      family: "lifecycle-hook" as const,
      plugin: Effect.succeed(providerPlugin("capture-hooks", "lifecycle-hook")),
      run: (input: { readonly hook: string; readonly service?: { readonly name: string } }) => {
        calls.push(`hook:${input.hook}:${input.service?.name ?? "project"}`)
        return Effect.succeed(`capture:hook:${input.hook}:${input.service?.name ?? "project"}`)
      },
    }),
    Layer.succeed(RigEventTransportProvider, {
      family: "event-transport" as const,
      plugin: Effect.succeed(structuredLogEventTransportProvider),
      append: (input) => {
        calls.push(`event:append:${input.event}${input.component ? `:${input.component}` : ""}`)
        return events.append(input, structuredLogEventTransportProvider)
      },
    }),
    Layer.succeed(RigPackageManagerProvider, {
      family: "package-manager" as const,
      plugin: Effect.succeed(packageJsonScriptsProvider),
      install: (input) => {
        calls.push(`package:install:${input.service.name}`)
        return packages.install(input, packageJsonScriptsProvider)
      },
    }),
    Layer.succeed(RigProxyRouterProvider, {
      family: "proxy-router" as const,
      plugin: Effect.succeed(caddyProxyRouterProvider),
      upsert: (input) => {
        calls.push(`proxy:upsert:${input.proxy.upstream}`)
        return caddy.upsert(input, caddyProxyRouterProvider)
      },
      remove: (input) => {
        calls.push(`proxy:remove:${input.proxy.upstream}`)
        return caddy.remove(input, caddyProxyRouterProvider)
      },
    }),
  )
}

describe("GIVEN rig runtime executor WHEN provider-backed operations run THEN provider interfaces are invoked", () => {
  test("GIVEN lifecycle up WHEN executed THEN workspace process health and event providers return ordered operations", async () => {
    const input: RigRuntimeLifecycleExecutionInput = {
      action: "up",
      deployment: deployment(),
    }

    const result = await runWithExecutor(
      Effect.gen(function* () {
        const executor = yield* RigRuntimeExecutor
        return yield* executor.lifecycle(input)
      }),
    )

    expect(result.operations).toEqual([
      "workspace-materializer:stub-workspace-materializer:resolve:/tmp/rig/workspaces/pantry/live",
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
    const root = await mkdtemp(join(tmpdir(), "rig-sqlite-prepare-"))
    const sqlitePath = join(root, "data", "db.sqlite")
    const calls: string[] = []
    const input: RigRuntimeLifecycleExecutionInput = {
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
      } as RigDeploymentRecord,
    }

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* RigRuntimeExecutor
          return yield* executor.lifecycle(input)
        }).pipe(Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer(calls)))),
      )

      expect(calls.indexOf("event:append:component.prepare:db")).toBeLessThan(calls.indexOf("process:up:api"))
      expect((await stat(dirname(sqlitePath))).isDirectory()).toBe(true)
      expect(dirname(sqlitePath)).toBe(join(root, "data"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN a deployment with a Convex component WHEN lifecycle up runs THEN its local state directory is prepared before processes start", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-convex-prepare-"))
    const stateDir = join(root, "workspace", ".convex", "local", "default")
    const calls: string[] = []
    const input: RigRuntimeLifecycleExecutionInput = {
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
      } as RigDeploymentRecord,
    }

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* RigRuntimeExecutor
          return yield* executor.lifecycle(input)
        }).pipe(Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer(calls)))),
      )

      expect(calls.indexOf("event:append:component.prepare:convex")).toBeLessThan(calls.indexOf("process:up:convex"))
      expect((await stat(stateDir)).isDirectory()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN a deployment with a Postgres component WHEN lifecycle up runs THEN its data directory is prepared before processes start", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-postgres-prepare-"))
    const dataDir = join(root, "postgres", "postgres")
    const calls: string[] = []
    const input: RigRuntimeLifecycleExecutionInput = {
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
      } as RigDeploymentRecord,
    }

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* RigRuntimeExecutor
          return yield* executor.lifecycle(input)
        }).pipe(Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer(calls)))),
      )

      expect(calls.indexOf("event:append:component.prepare:postgres")).toBeLessThan(calls.indexOf("process:up:postgres"))
      expect((await stat(dataDir)).isDirectory()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN lifecycle up starts a watched process WHEN it exits unexpectedly THEN the exit handler receives deployment and component context", async () => {
    let rejectObserved: (cause: unknown) => void = () => undefined
    const observed = new Promise<RigManagedProcessExitHandlerInput>((resolve, reject) => {
      rejectObserved = reject
      const input: RigRuntimeLifecycleExecutionInput = {
        action: "up",
        deployment: deployment(),
        onManagedProcessExit: (exit) =>
          Effect.sync(() => {
            resolve(exit)
          }),
      }

      Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* RigRuntimeExecutor
          return yield* executor.lifecycle(input)
        }).pipe(
          Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer([], {
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
        const executor = yield* RigRuntimeExecutor
        return yield* executor.lifecycle({
          action: "up",
          deployment: deployment(),
        })
      }).pipe(
        Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer(calls))),
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

  test("GIVEN lifecycle up fails after starting an earlier service THEN started services are stopped before failing", async () => {
    const calls: string[] = []

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* RigRuntimeExecutor
        return yield* executor.lifecycle({
          action: "up",
          deployment: deployment(),
        }).pipe(Effect.flip)
      }).pipe(
        Effect.provide(Layer.provide(
          RigRuntimeExecutorLive,
          captureProviderLayer(calls, { failProcess: ["process:up:worker"] }),
        )),
      ),
    )

    expect(error).toMatchObject({
      _tag: "RigRuntimeError",
      details: { reason: "captured-process-failed", operation: "process:up:worker" },
    })
    expect(calls).toEqual([
      "workspace:resolve:live",
      "process:up:web",
      "event:append:component.log:web",
      "health:check:web",
      "event:append:component.health:web",
      "process:up:worker",
      "process:down:web",
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
    } as RigDeploymentRecord

    await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* RigRuntimeExecutor
        yield* executor.lifecycle({
          action: "up",
          deployment: controlledDeployment,
        })
        yield* executor.lifecycle({
          action: "down",
          deployment: controlledDeployment,
        })
      }).pipe(
        Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer(calls, { healthChecks }))),
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
        const executor = yield* RigRuntimeExecutor
        return yield* executor.lifecycle({
          action: "up",
          deployment: deployment(),
        })
      }).pipe(
        Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer(calls, {
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
        const executor = yield* RigRuntimeExecutor
        return yield* executor.deploy({
          deployment: deployment(),
          ref: "feature/provider-methods",
        })
      }).pipe(
        Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer(calls))),
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
          workspacePath: "/tmp/rig/workspaces/pantry/live",
          dataRoot: "/tmp/rig/data/pantry/live",
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
    } as RigDeploymentRecord

    await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* RigRuntimeExecutor
        return yield* executor.deploy({
          deployment: runtimePlanDeployment,
          ref: "feature/runtime-plan",
        })
      }).pipe(
        Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer(calls))),
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

  testWithCaddy("GIVEN a Pantry-like live deploy dry run WHEN provider execution runs THEN routing sqlite state and CLI install stay isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-pantry-dry-run-"))
    const workspacePath = join(root, "workspace")
    const dataRoot = join(root, "data", "pantry", "live")
    const logRoot = join(root, "logs", "pantry", "live")
    const binRoot = join(root, "bin")
    const caddyfilePath = join(root, "Caddyfile")
    const sqlitePath = join(dataRoot, "sqlite", "sqlite.sqlite")
    const calls: string[] = []
    const appServer = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "text/plain" })
        response.end("pantry-live-ok")
        return
      }
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("not found")
    })
    let caddyProcess: ChildProcessWithoutNullStreams | undefined

    try {
      await mkdir(workspacePath, { recursive: true })
      const appPort = await listenOnRandomPort(appServer)
      const caddyPort = await reserveFreePort()
      await writeFile(caddyfilePath, [
        "{",
        "\tadmin off",
        "\tauto_https off",
        `\thttp_port ${caddyPort}`,
        "}",
        "",
      ].join("\n"))

      const pantryDeployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        branchSlug: "main",
        subdomain: "pantry",
        workspacePath,
        dataRoot,
        logRoot,
        runtimeRoot: join(root, "runtime", "pantry", "live"),
        runtimeStatePath: join(root, "runtime", "pantry", "live", "runtime.json"),
        assignedPorts: {
          web: appPort,
        },
        providerProfile: "default",
        resolved: {
          name: "pantry",
          repoPath: workspacePath,
          workspacePath,
          providerProfile: "default",
          providers: {
            processSupervisor: "rigd",
          },
          v1Config: {
            name: "pantry",
            domain: "http://pantry.test",
            version: "0.0.0",
            environments: {
              prod: {
                services: [],
              },
            },
          },
          environmentName: "live",
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: `bun run start -- --host 127.0.0.1 --port ${appPort} --sqlite ${sqlitePath}`,
                port: appPort,
                healthCheck: `http://127.0.0.1:${appPort}/health`,
              },
            ],
            proxy: {
              domain: "http://pantry.test",
              upstream: "web",
            },
          },
          runtimePlan: {
            project: "pantry",
            lane: "live",
            deploymentName: "live",
            branchSlug: "main",
            subdomain: "pantry",
            workspacePath,
            dataRoot,
            providerProfile: "default",
            providers: {
              processSupervisor: "rigd",
            },
            proxy: {
              upstream: "web",
            },
            components: [
              {
                name: "web",
                kind: "managed",
                command: `bun run start -- --host 127.0.0.1 --port ${appPort} --sqlite ${sqlitePath}`,
                port: appPort,
                health: `http://127.0.0.1:${appPort}/health`,
              },
              {
                name: "pantry",
                kind: "installed",
                entrypoint: "dist/pantry",
                build: "mkdir -p dist && printf '#!/bin/sh\\necho pantry-dry-run:$1\\n' > dist/pantry",
                installName: "pantry",
              },
            ],
            preparedComponents: [
              {
                name: "sqlite",
                uses: "sqlite",
                path: sqlitePath,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* RigRuntimeExecutor
          return yield* executor.deploy({
            deployment: pantryDeployment,
            ref: "main",
          })
        }).pipe(
          Effect.provide(Layer.provide(
            RigRuntimeExecutorLive,
            pantryDryRunProviderLayer(calls, { caddyfilePath, binRoot }),
          )),
        ),
      )

      caddyProcess = spawn(caddyPath!, [
        "run",
        "--config",
        caddyfilePath,
        "--adapter",
        "caddyfile",
      ], {
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data-home"),
        },
      })

      const body = await waitForCaddyRoute({
        port: caddyPort,
        host: "pantry.test",
        expected: "pantry-live-ok",
      })
      const installedCli = join(binRoot, "pantry")
      await chmod(installedCli, 0o755)
      const { stdout } = await execFileAsync(installedCli, ["ping"])
      const events = await readFile(join(logRoot, "events.jsonl"), "utf8")

      expect(body).toBe("pantry-live-ok")
      expect(stdout).toBe("pantry-dry-run:ping\n")
      expect((await stat(dirname(sqlitePath))).isDirectory()).toBe(true)
      expect(result.operations).toContain(`package-manager:package-json-scripts:install:pantry:installed:${installedCli}`)
      expect(result.operations).toContain(`proxy-router:caddy:upsert:http://pantry.test:web:${appPort}`)
      expect(calls).toEqual([
        "scm:checkout:main",
        "workspace:materialize:main",
        "event:append:component.prepare:sqlite",
        "package:install:pantry",
        "event:append:component.install:pantry",
        "process:restart:web",
        "event:append:component.log:web",
        "health:check:web",
        "event:append:component.health:web",
        "proxy:upsert:web",
        "event:append:deploy:main",
      ])
      expect(events).toContain('"event":"component.prepare"')
      expect(events).toContain(sqlitePath)
      expect(events).toContain('"event":"component.install"')
      expect(events).toContain('"event":"component.health"')
    } finally {
      if (caddyProcess && caddyProcess.exitCode === null && caddyProcess.signalCode === null) {
        const exited = waitForProcessExit(caddyProcess)
        caddyProcess.kill()
        await exited
      }
      await closeServer(appServer).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN a Pantry-like live deploy dry run WHEN CLI build fails THEN the package provider step is identified", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-pantry-dry-run-failure-"))
    const workspacePath = join(root, "workspace")
    const dataRoot = join(root, "data", "pantry", "live")
    const caddyfilePath = join(root, "Caddyfile")
    const binRoot = join(root, "bin")
    const sqlitePath = join(dataRoot, "sqlite", "sqlite.sqlite")

    try {
      await mkdir(workspacePath, { recursive: true })
      const failingDeployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath,
        dataRoot,
        logRoot: join(root, "logs", "pantry", "live"),
        providerProfile: "default",
        resolved: {
          name: "pantry",
          repoPath: workspacePath,
          workspacePath,
          providerProfile: "default",
          providers: {
            processSupervisor: "rigd",
          },
          v1Config: {
            name: "pantry",
            domain: "http://pantry.test",
            version: "0.0.0",
            environments: {
              prod: {
                services: [],
              },
            },
          },
          environmentName: "live",
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bun run start -- --host 127.0.0.1 --port 3070",
                port: 3070,
                healthCheck: "http://127.0.0.1:3070/health",
              },
            ],
            proxy: {
              domain: "http://pantry.test",
              upstream: "web",
            },
          },
          runtimePlan: {
            project: "pantry",
            lane: "live",
            deploymentName: "live",
            branchSlug: "main",
            subdomain: "pantry",
            workspacePath,
            dataRoot,
            providerProfile: "default",
            providers: {
              processSupervisor: "rigd",
            },
            proxy: {
              upstream: "web",
            },
            components: [
              {
                name: "web",
                kind: "managed",
                command: "bun run start -- --host 127.0.0.1 --port 3070",
                port: 3070,
                health: "http://127.0.0.1:3070/health",
              },
              {
                name: "pantry",
                kind: "installed",
                entrypoint: "dist/pantry",
                build: "echo pantry build failed >&2; exit 42",
                installName: "pantry",
              },
            ],
            preparedComponents: [
              {
                name: "sqlite",
                uses: "sqlite",
                path: sqlitePath,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* RigRuntimeExecutor
          return yield* executor.deploy({
            deployment: failingDeployment,
            ref: "main",
          })
        }).pipe(
          Effect.provide(Layer.provide(
            RigRuntimeExecutorLive,
            pantryDryRunProviderLayer([], { caddyfilePath, binRoot }),
          )),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        message: "Package build failed for 'pantry' with exit code 42.",
        details: {
          providerId: "package-json-scripts",
          component: "pantry",
          deployment: "live",
          build: "echo pantry build failed >&2; exit 42",
          exitCode: 42,
          stderr: "pantry build failed\n",
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
        const executor = yield* RigRuntimeExecutor
        return yield* executor.destroyGenerated({
          deployment: generated,
        })
      }).pipe(
        Effect.provide(Layer.provide(RigRuntimeExecutorLive, captureProviderLayer(calls))),
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
