import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import {
  RigControlPlaneTransportProvider,
  RigEventTransportProvider,
  RigHealthCheckerProvider,
  RigLifecycleHookProvider,
  RigPackageManagerProvider,
  RigProcessSupervisorProvider,
  RigProxyRouterProvider,
  RigProviderContractsLive,
  RigProviderRegistry,
  RigProviderRegistryLive,
  RigScmProvider,
  RigWorkspaceMaterializerProvider,
  rigProviderFamilies,
  type RigProviderPlugin,
} from "./provider-contracts.js"
import type { RigDeploymentRecord } from "./deployments.js"
import { RigFileHomeConfigStoreLive } from "./home-config.js"
import { stubProcessSupervisorProvider } from "./providers/stub-process-supervisor.js"
import { RigProviderContractsFromHomeConfigLive } from "./services.js"

const runWithRegistry = <A>(
  effect: Effect.Effect<A, unknown, RigProviderRegistry>,
  profile: "default" | "stub" | "isolated-e2e",
  externalProviders: readonly RigProviderPlugin[] = [],
) => Effect.runPromise(effect.pipe(Effect.provide(RigProviderRegistryLive(profile, externalProviders))))

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

describe("GIVEN rig provider plugin contracts WHEN registry reports profiles THEN provider composition is explicit", () => {
  test("GIVEN built-in profiles WHEN reported THEN every profile satisfies the same provider family contract", async () => {
    const reports = await Promise.all([
      runWithRegistry(Effect.gen(function* () {
        const registry = yield* RigProviderRegistry
        return yield* registry.current
      }), "default"),
      runWithRegistry(Effect.gen(function* () {
        const registry = yield* RigProviderRegistry
        return yield* registry.current
      }), "stub"),
      runWithRegistry(Effect.gen(function* () {
        const registry = yield* RigProviderRegistry
        return yield* registry.current
      }), "isolated-e2e"),
    ])

    for (const report of reports) {
      expect(report.families).toEqual(rigProviderFamilies)
      for (const family of rigProviderFamilies) {
        expect(report.providers.some((provider) => provider.family === family)).toBe(true)
      }
      expect(report.providers.every((provider) => provider.source === "core" || provider.source === "first-party")).toBe(true)
      expect(report.providers.every((provider) => provider.capabilities.length > 0)).toBe(true)
    }

    expect(reports[0].providers).toContainEqual(expect.objectContaining({
      id: "rigd",
      family: "process-supervisor",
      source: "core",
    }))
    expect(reports[0].providers).toContainEqual(expect.objectContaining({
      id: "launchd",
      family: "process-supervisor",
      source: "first-party",
    }))
  })

  test("GIVEN an external provider WHEN registered THEN it uses the same plugin shape as bundled providers", async () => {
    const cloudflareTunnel: RigProviderPlugin = {
      id: "cloudflare-tunnel",
      family: "tunnel",
      source: "external",
      displayName: "Cloudflare Tunnel",
      capabilities: ["public-internet", "token-pairing"],
      packageName: "@b-relay/rig-provider-cloudflare-tunnel",
    }

    const report = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* RigProviderRegistry
        return yield* registry.current
      }),
      "default",
      [cloudflareTunnel],
    )

    expect(report.profile).toBe("default")
    expect(report.providers).toContainEqual(cloudflareTunnel)
    expect(report.providers.find((provider) => provider.id === "manual-tailscale")).toMatchObject({
      family: "tunnel",
      source: "first-party",
    })
  })

  test("GIVEN provider selection at execution boundary WHEN a different profile is requested THEN command code can swap composition", async () => {
    const report = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* RigProviderRegistry
        return yield* registry.forProfile("stub")
      }),
      "default",
    )

    expect(report.profile).toBe("stub")
    expect(report.providers.every((provider) => provider.source === "core" || provider.id.startsWith("stub-"))).toBe(true)
    expect(report.providers.find((provider) => provider.family === "control-plane-transport")).toMatchObject({
      id: "stub-control-plane",
      capabilities: ["localhost-contract-test"],
    })
  })

  test("GIVEN provider contracts layer WHEN family services are requested THEN concrete imports are not needed", async () => {
    const selected = await Effect.runPromise(
      Effect.gen(function* () {
        const processSupervisor = yield* RigProcessSupervisorProvider
        const controlPlane = yield* RigControlPlaneTransportProvider
        const healthChecker = yield* RigHealthCheckerProvider

        return {
          processSupervisor: yield* processSupervisor.plugin,
          controlPlane: yield* controlPlane.plugin,
          healthChecker: yield* healthChecker.plugin,
        }
      }).pipe(Effect.provide(RigProviderContractsLive("isolated-e2e"))),
    )

    expect(selected.processSupervisor).toMatchObject({
      id: "rigd",
      family: "process-supervisor",
    })
    expect(selected.controlPlane).toMatchObject({
      id: "localhost-http",
      family: "control-plane-transport",
    })
    expect(selected.healthChecker).toMatchObject({
      id: "native-health",
      family: "health-checker",
    })
  })

  test("GIVEN stub process supervisor adapter WHEN the stub profile is composed THEN it satisfies the process supervisor contract", async () => {
    const deployment = {
      project: "pantry",
      kind: "generated",
      name: "feature-a",
      workspacePath: "/tmp/rig-stub-contract",
      resolved: {
        providers: {
          processSupervisor: "stub-process-supervisor",
        },
      },
    } as RigDeploymentRecord
    const service = {
      name: "web",
      type: "server",
      command: "bun run start",
      port: 3070,
    } as const

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RigProviderRegistry
        const report = yield* registry.current
        const processSupervisor = yield* RigProcessSupervisorProvider
        return {
          stubPlugin: report.providers.find((provider) => provider.id === "stub-process-supervisor"),
          up: yield* processSupervisor.up({ deployment, service }),
          down: yield* processSupervisor.down({ deployment, service }),
          restart: yield* processSupervisor.restart({ deployment, service }),
        }
      }).pipe(Effect.provide(RigProviderContractsLive("stub"))),
    )

    expect(result.stubPlugin).toBe(stubProcessSupervisorProvider)
    expect(result.up).toEqual({
      operation: "process-supervisor:stub-process-supervisor:up:web",
    })
    expect(result.down).toEqual({
      operation: "process-supervisor:stub-process-supervisor:down:web",
    })
    expect(result.restart).toEqual({
      operation: "process-supervisor:stub-process-supervisor:restart:web",
    })
  })

  test("GIVEN remaining stub adapters WHEN the stub profile is composed THEN operation strings stay compatible", async () => {
    const deployment = {
      project: "pantry",
      kind: "generated",
      name: "feature-a",
      workspacePath: "/tmp/rig-stub-contract",
      logRoot: "/tmp/rig-stub-contract/logs",
      resolved: {
        providers: {
          processSupervisor: "stub-process-supervisor",
        },
      },
    } as RigDeploymentRecord
    const service = {
      name: "web",
      type: "server",
      command: "bun run start",
      port: 3070,
    } as const
    const binService = {
      name: "tool",
      type: "bin",
      entrypoint: "bin/tool",
    } as const
    const proxy = {
      domain: "feature-a.preview.b-relay.com",
      upstream: "web",
    } as const

    const operations = await Effect.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* RigWorkspaceMaterializerProvider
        const scm = yield* RigScmProvider
        const events = yield* RigEventTransportProvider
        const health = yield* RigHealthCheckerProvider
        const hooks = yield* RigLifecycleHookProvider
        const packages = yield* RigPackageManagerProvider
        const proxyRouter = yield* RigProxyRouterProvider

        return [
          yield* workspaces.resolve({ deployment }),
          yield* workspaces.materialize({ deployment, ref: "feature/a" }),
          yield* workspaces.remove({ deployment }),
          yield* scm.checkout({ deployment, ref: "feature/a" }),
          yield* events.append({ deployment, event: "component.log", component: "web" }),
          yield* health.check({ deployment, service }),
          yield* hooks.run({ deployment, hook: "preStart", command: "echo ready", service }),
          yield* packages.install({ deployment, service: binService }),
          yield* proxyRouter.upsert({ deployment, proxy }),
          yield* proxyRouter.remove({ deployment, proxy }),
        ] as const
      }).pipe(Effect.provide(RigProviderContractsLive("stub"))),
    )

    expect(operations).toEqual([
      "workspace-materializer:stub-workspace-materializer:resolve:/tmp/rig-stub-contract",
      "workspace-materializer:stub-workspace-materializer:materialize:/tmp/rig-stub-contract",
      "workspace-materializer:stub-workspace-materializer:remove:/tmp/rig-stub-contract",
      "scm:stub-scm:checkout:feature/a",
      "event-transport:stub-event-transport:append:component.log:web",
      "health-checker:stub-health-checker:check:web",
      "lifecycle-hook:stub-lifecycle-hook:run:preStart:web",
      "package-manager:stub-package-manager:install:tool",
      "proxy-router:stub-proxy-router:upsert:web",
      "proxy-router:stub-proxy-router:remove:web",
    ])
  })

  test("GIVEN git-worktree materializer WHEN deployment is materialized THEN workspace commands run in isolated rig paths", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-worktree-"))
    const sourceRepo = join(stateRoot, "repo")
    const workspacePath = join(stateRoot, "workspaces", "pantry", "deployments", "feature-a")
    const commands: string[][] = []

    try {
      const deployment = {
        project: "pantry",
        kind: "generated",
        name: "feature-a",
        workspacePath,
        resolved: {
          v1Config: {
            repoPath: sourceRepo,
          },
        },
      } as RigDeploymentRecord

      const [materialized, resolved, removed] = await Effect.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* RigWorkspaceMaterializerProvider
          return [
            yield* workspaces.materialize({ deployment, ref: "feature/a" }),
            yield* workspaces.resolve({ deployment }),
            yield* workspaces.remove({ deployment }),
          ] as const
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          workspaceMaterializer: {
            runCommand: async (args) => {
              commands.push([...args])
              return { stdout: "", stderr: "", exitCode: 0 }
            },
          },
        }))),
      )

      expect(materialized).toBe(`workspace-materializer:git-worktree:materialize:${workspacePath}:feature/a`)
      expect(resolved).toBe(`workspace-materializer:git-worktree:resolve:${workspacePath}`)
      expect(removed).toBe(`workspace-materializer:git-worktree:remove:${workspacePath}`)
      expect(commands).toEqual([
        ["git", "-C", sourceRepo, "worktree", "remove", "--force", workspacePath],
        ["git", "-C", sourceRepo, "worktree", "add", "--force", "--detach", workspacePath, "feature/a"],
        ["git", "-C", sourceRepo, "worktree", "remove", "--force", workspacePath],
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN local-git SCM provider WHEN checkout runs THEN ref is fetched and verified in the source repo", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-scm-"))
    const sourceRepo = join(stateRoot, "repo")
    const commands: string[][] = []

    try {
      const deployment = {
        project: "pantry",
        kind: "generated",
        name: "feature-a",
        workspacePath: join(stateRoot, "workspaces", "pantry", "deployments", "feature-a"),
        resolved: {
          sourceRepoPath: sourceRepo,
        },
      } as RigDeploymentRecord

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const scm = yield* RigScmProvider
          return yield* scm.checkout({ deployment, ref: "feature/a" })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          scm: {
            runCommand: async (args) => {
              commands.push([...args])
              return { stdout: "abc123\n", stderr: "", exitCode: 0 }
            },
          },
        }))),
      )

      expect(result).toBe(`scm:local-git:checkout:feature/a:abc123`)
      expect(commands).toEqual([
        ["git", "-C", sourceRepo, "fetch", "--prune", "origin"],
        ["git", "-C", sourceRepo, "rev-parse", "--verify", "feature/a^{commit}"],
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN local-git SCM provider WHEN ref verification fails THEN a tagged missing ref error is returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-scm-missing-ref-"))
    const sourceRepo = join(stateRoot, "repo")

    try {
      const deployment = {
        project: "pantry",
        kind: "generated",
        name: "feature-a",
        workspacePath: join(stateRoot, "workspaces", "pantry", "deployments", "feature-a"),
        resolved: {
          sourceRepoPath: sourceRepo,
        },
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const scm = yield* RigScmProvider
          return yield* scm.checkout({ deployment, ref: "feature/missing" })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default", [], {
            scm: {
              runCommand: async (args) =>
                args.includes("rev-parse")
                  ? { stdout: "", stderr: "unknown revision", exitCode: 1 }
                  : { stdout: "", stderr: "", exitCode: 0 },
            },
          })),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        message: "Unable to resolve deploy ref 'feature/missing'.",
        details: {
          providerId: "local-git",
          repoPath: sourceRepo,
          ref: "feature/missing",
          stderr: "unknown revision",
        },
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN local-git SCM provider WHEN source repo cannot be resolved THEN a tagged source error is returned", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-scm-missing-source-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "generated",
        name: "feature-a",
        workspacePath: join(stateRoot, "workspaces", "pantry", "deployments", "feature-a"),
        resolved: {},
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const scm = yield* RigScmProvider
          return yield* scm.checkout({ deployment, ref: "feature/a" })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        message: "Unable to resolve source repo for deployment 'feature-a'.",
        details: {
          providerId: "local-git",
          deployment: "feature-a",
          workspacePath: deployment.workspacePath,
        },
      })
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN git-worktree materializer WHEN workspace is already missing THEN remove remains idempotent", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-worktree-missing-remove-"))
    const sourceRepo = join(stateRoot, "repo")
    const workspacePath = join(stateRoot, "workspaces", "pantry", "deployments", "feature-a")
    const commands: string[][] = []

    try {
      const deployment = {
        project: "pantry",
        kind: "generated",
        name: "feature-a",
        workspacePath,
        resolved: {
          sourceRepoPath: sourceRepo,
        },
      } as RigDeploymentRecord

      const removed = await Effect.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* RigWorkspaceMaterializerProvider
          return yield* workspaces.remove({ deployment })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          workspaceMaterializer: {
            runCommand: async (args) => {
              commands.push([...args])
              return { stdout: "", stderr: "fatal: not a working tree", exitCode: 128 }
            },
          },
        }))),
      )

      expect(removed).toBe(`workspace-materializer:git-worktree:remove:${workspacePath}`)
      expect(commands).toEqual([
        ["git", "-C", sourceRepo, "worktree", "remove", "--force", workspacePath],
      ])
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy proxy router WHEN route is upserted and removed THEN rig-managed Caddy blocks are isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-caddy-"))
    const caddyfilePath = join(root, "Caddyfile")
    const manualBlock = [
      "manual.example.com {",
      "\treverse_proxy http://127.0.0.1:9000",
      "}",
      "",
    ].join("\n")

    try {
      await writeFile(caddyfilePath, manualBlock)
      const deployment = {
        project: "pantry",
        kind: "generated",
        name: "feature-a",
        resolved: {
          v1Config: {
            domain: "feature-a.preview.b-relay.com",
          },
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bun run dev",
                port: 4173,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      const upserted = await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* RigProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
          },
        }))),
      )

      const contentAfterUpsert = await readFile(caddyfilePath, "utf8")
      const removed = await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* RigProxyRouterProvider
          return yield* proxy.remove({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
          },
        }))),
      )
      const contentAfterRemove = await readFile(caddyfilePath, "utf8")

      expect(upserted).toBe("proxy-router:caddy:upsert:feature-a.preview.b-relay.com:web:4173")
      expect(contentAfterUpsert).toContain("manual.example.com")
      expect(contentAfterUpsert).toContain("# [rig:pantry:feature-a:web]")
      expect(contentAfterUpsert).toContain("feature-a.preview.b-relay.com {")
      expect(contentAfterUpsert).toContain("reverse_proxy http://127.0.0.1:4173")
      expect(removed).toBe("proxy-router:caddy:remove:pantry:feature-a:web")
      expect(contentAfterRemove).toContain("manual.example.com")
      expect(contentAfterRemove).not.toContain("[rig:pantry:feature-a:web]")
      expect((await readdir(root)).filter((file) => file.startsWith("Caddyfile.backup-")).length).toBeGreaterThanOrEqual(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy proxy router WHEN pantry live is routed THEN pantry.b-relay.com points at the selected localhost service", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-pantry-caddy-"))
    const caddyfilePath = join(root, "Caddyfile")

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        resolved: {
          v1Config: {
            domain: "pantry.b-relay.com",
          },
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bun run start -- --host 127.0.0.1 --port 3070",
                port: 3070,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* RigProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
          },
        }))),
      )

      const caddyfile = await readFile(caddyfilePath, "utf8")
      expect(operation).toBe("proxy-router:caddy:upsert:pantry.b-relay.com:web:3070")
      expect(caddyfile).toContain("# [rig:pantry:live:web]")
      expect(caddyfile).toContain("pantry.b-relay.com {")
      expect(caddyfile).toContain("reverse_proxy http://127.0.0.1:3070")
      expect(caddyfile).not.toContain("import cloudflare")
      expect(caddyfile).not.toContain("import backend_errors")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  testWithCaddy("GIVEN caddy proxy router WHEN real Caddy runs with an isolated Caddyfile THEN the routed app is reachable", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-caddy-reachability-"))
    const caddyfilePath = join(root, "Caddyfile")
    const appServer = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "text/plain" })
        response.end("rig-caddy-ok")
        return
      }
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("not found")
    })
    let caddyProcess: ChildProcessWithoutNullStreams | undefined

    try {
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

      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        resolved: {
          v1Config: {
            domain: "http://pantry.test",
          },
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: `bun run start -- --host 127.0.0.1 --port ${appPort}`,
                port: appPort,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* RigProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
          },
        }))),
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
          XDG_DATA_HOME: join(root, "data"),
        },
      })

      const body = await waitForCaddyRoute({
        port: caddyPort,
        host: "pantry.test",
        expected: "rig-caddy-ok",
      })

      expect(body).toBe("rig-caddy-ok")
    } finally {
      if (caddyProcess) {
        if (caddyProcess.exitCode === null && caddyProcess.signalCode === null) {
          const exited = waitForProcessExit(caddyProcess)
          caddyProcess.kill()
          await exited
        }
      }
      await closeServer(appServer).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy proxy router WHEN pantry already exists without a rig marker THEN upsert adopts the existing site instead of duplicating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-pantry-caddy-adopt-"))
    const caddyfilePath = join(root, "Caddyfile")
    const existing = [
      "(cloudflare) {",
      "\ttls {",
      "\t\tdns cloudflare {$CLOUDFLARE_API_TOKEN}",
      "\t}",
      "}",
      "",
      "# pantry - grocery & meal tracker",
      "pantry.b-relay.com {",
      "\treverse_proxy http://127.0.0.1:3070",
      "\timport cloudflare",
      "\timport backend_errors",
      "}",
      "",
      "core.b-relay.com {",
      "\treverse_proxy http://127.0.0.1:3100",
      "\timport cloudflare",
      "\timport backend_errors",
      "}",
      "",
    ].join("\n")

    try {
      await writeFile(caddyfilePath, existing)
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        resolved: {
          v1Config: {
            domain: "pantry.b-relay.com",
          },
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bun run start -- --host 127.0.0.1 --port 3070",
                port: 3070,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* RigProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
          },
        }))),
      )

      const caddyfile = await readFile(caddyfilePath, "utf8")
      expect(caddyfile.match(/pantry\.b-relay\.com \{/g)).toHaveLength(1)
      expect(caddyfile).toContain("# [rig:pantry:live:web]")
      expect(caddyfile).toContain("core.b-relay.com {")
      expect(caddyfile).toContain("(cloudflare) {")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy proxy router config WHEN extra config is set THEN it renders inside each managed site block", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-caddy-extra-config-"))
    const caddyfilePath = join(root, "Caddyfile")

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        resolved: {
          v1Config: {
            domain: "pantry.b-relay.com",
          },
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bun run start -- --host 127.0.0.1 --port 3070",
                port: 3070,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* RigProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
            extraConfig: ["import cloudflare", "import backend_errors"],
          },
        }))),
      )

      const caddyfile = await readFile(caddyfilePath, "utf8")
      expect(caddyfile).toContain("reverse_proxy http://127.0.0.1:3070")
      expect(caddyfile).toContain("\timport cloudflare")
      expect(caddyfile).toContain("\timport backend_errors")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy proxy router config WHEN reload command mode is set THEN it runs the configured reload command after writing the route", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-caddy-reload-command-"))
    const caddyfilePath = join(root, "Caddyfile")
    const commands: string[][] = []

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        resolved: {
          v1Config: {
            domain: "pantry.b-relay.com",
          },
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bun run start -- --host 127.0.0.1 --port 3070",
                port: 3070,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* RigProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
            reload: {
              mode: "command",
              command: "caddy reload --config /usr/local/etc/Caddyfile",
            },
            runCommand: async (args) => {
              commands.push([...args])
              return { stdout: "", stderr: "", exitCode: 0 }
            },
          },
        }))),
      )

      expect(commands).toEqual([["sh", "-lc", "caddy reload --config /usr/local/etc/Caddyfile"]])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy proxy router config WHEN reload command fails THEN the error stays tagged with route context", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-caddy-reload-error-"))
    const caddyfilePath = join(root, "Caddyfile")
    const original = "example.test {\n\trespond \"stable\"\n}\n"

    try {
      await writeFile(caddyfilePath, original)
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: "/tmp/rig/workspaces/pantry/live",
        resolved: {
          v1Config: {
            domain: "pantry.b-relay.com",
          },
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bun run start",
                port: 3070,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* RigProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default", [], {
            proxyRouter: {
              caddyfilePath,
              reload: {
                mode: "command",
                command: "caddy reload --config /usr/local/etc/Caddyfile",
              },
              runCommand: async () => ({ stdout: "out", stderr: "bad caddyfile", exitCode: 1 }),
            },
          })),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        message: "Unable to upsert Caddy route for deployment 'live'.",
        details: {
          providerId: "caddy",
          caddyfilePath,
          project: "pantry",
          deployment: "live",
          upstream: "web",
          domain: "pantry.b-relay.com",
          port: 3070,
          cause: "Caddy reload command failed.",
        },
      })
      expect(await readFile(caddyfilePath, "utf8")).toBe(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy provider settings in rig home config WHEN default provider contracts are composed THEN routes use those settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-caddy-home-config-"))
    const caddyfilePath = join(root, "system-Caddyfile")
    const previousRoot = process.env.RIG_ROOT
    process.env.RIG_ROOT = root

    try {
      await writeFile(join(root, "config.json"), JSON.stringify({
        providers: {
          caddy: {
            caddyfile: caddyfilePath,
            extraConfig: ["import cloudflare"],
            reload: {
              mode: "manual",
            },
          },
        },
      }))

      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        resolved: {
          v1Config: {
            domain: "pantry.b-relay.com",
          },
          environment: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bun run start -- --host 127.0.0.1 --port 3070",
                port: 3070,
              },
            ],
          },
        },
      } as RigDeploymentRecord

      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* RigProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(Layer.provide(
          RigProviderContractsFromHomeConfigLive,
          RigFileHomeConfigStoreLive,
        ))),
      )

      const caddyfile = await readFile(caddyfilePath, "utf8")
      expect(caddyfile).toContain("pantry.b-relay.com {")
      expect(caddyfile).toContain("\timport cloudflare")
    } finally {
      if (previousRoot === undefined) {
        delete process.env.RIG_ROOT
      } else {
        process.env.RIG_ROOT = previousRoot
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN launchd process supervisor WHEN lifecycle operations run THEN rig launchd plists are installed and removed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-launchd-workspace-"))
    const home = await mkdtemp(join(tmpdir(), "rig-launchd-home-"))
    const commands: string[][] = []

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
        logRoot: join(home, "logs"),
        resolved: {
          providers: {
            processSupervisor: "launchd",
          },
        },
      } as RigDeploymentRecord

      const up = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* RigProcessSupervisorProvider
          return yield* processSupervisor.up({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: 3070,
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          launchd: {
            home,
            runCommand: async (args) => {
              commands.push([...args])
              return { stdout: "", stderr: "", exitCode: 0 }
            },
          },
        }))),
      )

      const label = "com.b-relay.rig.pantry.live.web"
      const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`)
      const plist = await readFile(plistPath, "utf8")

      const down = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* RigProcessSupervisorProvider
          return yield* processSupervisor.down({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: 3070,
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          launchd: {
            home,
            runCommand: async (args) => {
              commands.push([...args])
              return { stdout: "", stderr: "", exitCode: 0 }
            },
          },
        }))),
      )

      expect(up.operation).toBe("process-supervisor:launchd:up:web:installed")
      expect(down.operation).toBe("process-supervisor:launchd:down:web:removed")
      expect(plist).toContain(`<string>${label}</string>`)
      expect(plist).toContain(`<string>/bin/sh</string>`)
      expect(plist).toContain(`<string>-lc</string>`)
      expect(plist).toContain(`<string>bun run start</string>`)
      expect(plist).toContain(`<string>${workspace}</string>`)
      expect(commands).toEqual([
        ["launchctl", "bootout", expect.stringContaining(label)],
        ["launchctl", "bootstrap", expect.stringMatching(/^gui\/\d+$/), plistPath],
        ["launchctl", "bootout", expect.stringContaining(label)],
      ])
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  test("GIVEN launchd process supervisor WHEN bootstrap fails THEN the error is tagged and actionable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-launchd-bootstrap-workspace-"))
    const home = await mkdtemp(join(tmpdir(), "rig-launchd-bootstrap-home-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
        logRoot: join(home, "logs"),
        resolved: {
          providers: {
            processSupervisor: "launchd",
          },
        },
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* RigProcessSupervisorProvider
          return yield* processSupervisor.up({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: 3070,
            },
          })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default", [], {
            launchd: {
              home,
              runCommand: async (args) =>
                args[1] === "bootstrap"
                  ? { stdout: "", stderr: "invalid plist", exitCode: 78 }
                  : { stdout: "", stderr: "", exitCode: 0 },
            },
          })),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        message: "launchd failed to bootstrap 'web' with exit code 78.",
        hint: "Inspect the generated plist and launchctl stderr, then retry the lifecycle action.",
        details: {
          providerId: "launchd",
          component: "web",
          deployment: "live",
          stderr: "invalid plist",
        },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  test("GIVEN a deployment-selected process supervisor WHEN executing operations THEN bundled providers share the same interface", async () => {
    const home = await mkdtemp(join(tmpdir(), "rig-launchd-interface-"))

    const deployment = {
      project: "pantry",
      kind: "live",
      name: "live",
      workspacePath: "/tmp/rig/workspaces/pantry/live",
      logRoot: join(home, "logs"),
      resolved: {
        providers: {
          processSupervisor: "launchd",
        },
      },
    } as RigDeploymentRecord

    try {
      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* RigProcessSupervisorProvider
          return yield* processSupervisor.up({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: 3070,
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          launchd: {
            home,
            runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          },
        }))),
      )

      expect(operation).toEqual({
        operation: "process-supervisor:launchd:up:web:installed",
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("GIVEN rigd process supervisor WHEN managed command exits quickly THEN start fails with command output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-rigd-process-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
        resolved: {
          providers: {
            processSupervisor: "rigd",
          },
        },
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* RigProcessSupervisorProvider
          return yield* processSupervisor.up({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "printf 'ready\\n'; printf 'warn\\n' >&2",
              port: 3070,
            },
          })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        details: {
          providerId: "rigd",
          component: "web",
          deployment: "live",
          exitCode: 0,
          stdout: "ready",
          stderr: "warn",
        },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN rigd process supervisor WHEN a running process is restarted THEN the previous process exits expectedly", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-rigd-process-restart-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
        resolved: {
          providers: {
            processSupervisor: "rigd",
          },
        },
      } as RigDeploymentRecord
      const firstService = {
        name: "web",
        type: "server",
        command: "printf first; sleep 10",
        port: 3070,
      } as const
      const replacementService = {
        ...firstService,
        command: "printf restarted; sleep 10",
      }

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* RigProcessSupervisorProvider
          const started = yield* processSupervisor.up({
            deployment,
            service: firstService,
          })
          const restarted = yield* processSupervisor.restart({
            deployment,
            service: replacementService,
          })
          const firstExit = yield* started.exit!
          const down = yield* processSupervisor.down({
            deployment,
            service: replacementService,
          })
          return { started, restarted, firstExit, down }
        }).pipe(Effect.provide(RigProviderContractsLive("default"))),
      )

      expect(result.started.operation).toBe("process-supervisor:rigd:up:web:started")
      expect(result.restarted.operation).toBe("process-supervisor:rigd:restart:web:started")
      expect(result.firstExit).toEqual(expect.objectContaining({
        expected: true,
      }))
      expect(result.down.operation).toContain("process-supervisor:rigd:down:web:stopped")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN rigd process supervisor WHEN a started process exits later THEN its exit effect reports output and code", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-rigd-process-watch-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
        resolved: {
          providers: {
            processSupervisor: "rigd",
          },
        },
      } as RigDeploymentRecord

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* RigProcessSupervisorProvider
          return yield* processSupervisor.up({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "printf started; sleep 0.05; printf crashed >&2; exit 7",
              port: 3070,
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default"))),
      )

      expect(result.operation).toBe("process-supervisor:rigd:up:web:started")
      expect(result.exit).toBeDefined()
      const exit = await Effect.runPromise(result.exit!)
      expect(exit).toEqual({
        expected: false,
        exitCode: 7,
        stdout: "started",
        stderr: "crashed",
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN structured-log-file event transport WHEN appending THEN it writes deployment JSONL", async () => {
    const logRoot = await mkdtemp(join(tmpdir(), "rig-provider-events-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        logRoot,
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* RigEventTransportProvider
          return yield* events.append({
            deployment,
            event: "component.log",
            component: "web",
            details: {
              line: "started",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default"))),
      )

      const raw = await readFile(join(logRoot, "events.jsonl"), "utf8")
      const entries = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(operation).toBe("event-transport:structured-log-file:append:component.log:web")
      expect(entries).toEqual([
        expect.objectContaining({
          event: "component.log",
          project: "pantry",
          kind: "live",
          deployment: "live",
          component: "web",
          details: {
            line: "started",
          },
        }),
      ])
      expect(typeof entries[0]?.timestamp).toBe("string")
    } finally {
      await rm(logRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN native-health provider WHEN HTTP check is healthy THEN it verifies the component", async () => {
    const server = await listen((_, response) => {
      response.writeHead(204)
      response.end()
    })

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* RigHealthCheckerProvider
          return yield* health.check({
            deployment,
            timeoutSeconds: 0.05,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: server.port,
              healthCheck: `http://127.0.0.1:${server.port}/health`,
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default"))),
      )

      expect(operation).toBe("health-checker:native-health:check:web:healthy:204")
    } finally {
      await closeServer(server.instance)
    }
  })

  test("GIVEN native-health provider WHEN HTTP endpoint becomes ready before timeout THEN it polls until healthy", async () => {
    let attempts = 0
    const server = await listen((_, response) => {
      attempts += 1
      if (attempts < 2) {
        response.writeHead(503)
        response.end("not ready")
        return
      }
      response.writeHead(204)
      response.end()
    })

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* RigHealthCheckerProvider
          return yield* health.check({
            deployment,
            timeoutSeconds: 1,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: server.port,
              healthCheck: `http://127.0.0.1:${server.port}/health`,
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default"))),
      )

      expect(operation).toBe("health-checker:native-health:check:web:healthy:204")
      expect(attempts).toBeGreaterThanOrEqual(2)
    } finally {
      await closeServer(server.instance)
    }
  })

  test("GIVEN native-health provider WHEN HTTP check is unhealthy THEN it returns a tagged runtime error", async () => {
    const server = await listen((_, response) => {
      response.writeHead(503)
      response.end("not ready")
    })

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* RigHealthCheckerProvider
          return yield* health.check({
            deployment,
            timeoutSeconds: 0.05,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: server.port,
              healthCheck: `http://127.0.0.1:${server.port}/health`,
            },
          })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        details: {
          providerId: "native-health",
          component: "web",
          statusCode: 503,
        },
      })
    } finally {
      await closeServer(server.instance)
    }
  })

  test("GIVEN native-health provider WHEN command check exits zero THEN it verifies the component", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-command-health-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* RigHealthCheckerProvider
          return yield* health.check({
            deployment,
            service: {
              name: "worker",
              type: "server",
              command: "bun run worker",
              healthCheck: "printf ready",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default"))),
      )

      expect(operation).toBe("health-checker:native-health:check:worker:command:healthy:0")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN native-health provider WHEN command check exits nonzero THEN it returns a tagged runtime error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-command-health-fail-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* RigHealthCheckerProvider
          return yield* health.check({
            deployment,
            service: {
              name: "worker",
              type: "server",
              command: "bun run worker",
              healthCheck: "printf not-ready >&2; exit 7",
            },
          })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        details: {
          providerId: "native-health",
          component: "worker",
          exitCode: 7,
          stderr: "not-ready",
        },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN native-health provider WHEN command check exceeds the timeout THEN it returns a tagged runtime error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-command-health-timeout-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* RigHealthCheckerProvider
          return yield* health.check({
            deployment,
            timeoutSeconds: 0.01,
            service: {
              name: "worker",
              type: "server",
              command: "bun run worker",
              healthCheck: "sleep 0.2",
            },
          })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        details: {
          providerId: "native-health",
          component: "worker",
          timeoutSeconds: 0.01,
        },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN shell lifecycle hook provider WHEN a hook command succeeds THEN it runs in the deployment workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-shell-hook-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const hooks = yield* RigLifecycleHookProvider
          return yield* hooks.run({
            deployment,
            hook: "preStart",
            command: "printf hook > hook.txt",
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: 3070,
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default"))),
      )

      expect(operation).toBe("lifecycle-hook:shell-hook:run:preStart:web:0")
      await expect(readFile(join(workspace, "hook.txt"), "utf8")).resolves.toBe("hook")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN shell lifecycle hook provider WHEN a hook command fails THEN it returns a tagged runtime error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-shell-hook-fail-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord
      const service = {
        name: "web",
        type: "server",
        command: "bun run start",
        port: 3070,
      } as const

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const hooks = yield* RigLifecycleHookProvider
          return yield* hooks.run({
            deployment,
            hook: "preStart",
            command: "printf broken >&2; exit 9",
            service,
          })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        message: "Lifecycle hook 'preStart' failed for 'web' with exit code 9.",
        details: {
          providerId: "shell-hook",
          hook: "preStart",
          command: "printf broken >&2; exit 9",
          project: "pantry",
          deployment: "live",
          component: "web",
          exitCode: 9,
          stderr: "broken",
        },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN package-json-scripts provider WHEN installed component has build command THEN it runs in the deployment workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-package-install-"))
    const workspace = join(root, "workspace")
    const binRoot = join(root, "bin")

    try {
      await mkdir(workspace, { recursive: true })
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* RigPackageManagerProvider
          return yield* packages.install({
            deployment,
            service: {
              name: "tool",
              type: "bin",
              entrypoint: "dist/tool",
              build: "mkdir -p dist && printf built > dist/tool",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          packageManager: {
            binRoot,
          },
        }))),
      )

      expect(operation).toBe(`package-manager:package-json-scripts:install:tool:installed:${join(binRoot, "tool")}`)
      expect(await readFile(join(workspace, "dist", "tool"), "utf8")).toBe("built")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN package-json-scripts provider WHEN command entrypoint is installed THEN it writes a command shim", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-package-command-shim-"))
    const workspace = join(root, "workspace")
    const binRoot = join(root, "bin")

    try {
      await mkdir(workspace, { recursive: true })
      const deployment = {
        project: "pantry",
        kind: "local",
        name: "local",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* RigPackageManagerProvider
          return yield* packages.install({
            deployment,
            service: {
              name: "tool",
              type: "bin",
              entrypoint: "node ./src/cli.js --flag",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          packageManager: {
            binRoot,
          },
        }))),
      )

      const destination = join(binRoot, "tool-dev")
      expect(operation).toBe(`package-manager:package-json-scripts:install:tool:installed:${destination}`)
      expect(await readFile(destination, "utf8")).toBe(
        `#!/bin/sh\ncd ${JSON.stringify(workspace)} && exec node ./src/cli.js --flag "$@"\n`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN package-json-scripts provider WHEN text file entrypoint is installed THEN it writes a script shim", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-package-script-shim-"))
    const workspace = join(root, "workspace")
    const binRoot = join(root, "bin")

    try {
      await mkdir(join(workspace, "scripts"), { recursive: true })
      await writeFile(join(workspace, "scripts", "tool.js"), "console.log('tool')\n")
      const deployment = {
        project: "pantry",
        kind: "generated",
        name: "feature-a",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* RigPackageManagerProvider
          return yield* packages.install({
            deployment,
            service: {
              name: "tool",
              type: "bin",
              entrypoint: "scripts/tool.js",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          packageManager: {
            binRoot,
          },
        }))),
      )

      const destination = join(binRoot, "tool-feature-a")
      expect(operation).toBe(`package-manager:package-json-scripts:install:tool:installed:${destination}`)
      expect(await readFile(destination, "utf8")).toBe(
        `#!/bin/sh\ncd ${JSON.stringify(workspace)} && exec ./scripts/tool.js "$@"\n`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN package-json-scripts provider WHEN binary entrypoint is installed THEN it copies the binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-package-binary-copy-"))
    const workspace = join(root, "workspace")
    const binRoot = join(root, "bin")

    try {
      await mkdir(join(workspace, "bin"), { recursive: true })
      await writeFile(join(workspace, "bin", "tool"), new Uint8Array([0, 1, 2, 3]))
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* RigPackageManagerProvider
          return yield* packages.install({
            deployment,
            service: {
              name: "tool",
              type: "bin",
              entrypoint: "bin/tool",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          packageManager: {
            binRoot,
          },
        }))),
      )

      const destination = join(binRoot, "tool")
      expect(operation).toBe(`package-manager:package-json-scripts:install:tool:installed:${destination}`)
      expect([...await readFile(destination)]).toEqual([0, 1, 2, 3])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN package-json-scripts provider WHEN entrypoint escapes workspace THEN it returns a tagged path error", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-package-unsafe-entrypoint-"))
    const workspace = join(root, "workspace")

    try {
      await mkdir(workspace, { recursive: true })
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* RigPackageManagerProvider
          return yield* packages.install({
            deployment,
            service: {
              name: "tool",
              type: "bin",
              entrypoint: "../outside.js",
            },
          })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        message: "Installed component 'tool' resolves outside the deployment workspace.",
        details: {
          providerId: "package-json-scripts",
          component: "tool",
          deployment: "live",
          entrypoint: "../outside.js",
          workspacePath: workspace,
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN package-json-scripts provider WHEN build command fails THEN it returns a tagged runtime error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-package-install-fail-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* RigPackageManagerProvider
          return yield* packages.install({
            deployment,
            service: {
              name: "tool",
              type: "bin",
              entrypoint: "src/cli.ts",
              build: "printf build-failed >&2; exit 9",
            },
          })
        }).pipe(
          Effect.provide(RigProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "RigRuntimeError",
        details: {
          providerId: "package-json-scripts",
          component: "tool",
          build: "printf build-failed >&2; exit 9",
          exitCode: 9,
          stderr: "build-failed",
        },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN package-json-scripts provider WHEN pantry CLI is built THEN it installs the pantry executable into the rig bin root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-pantry-cli-"))
    const workspace = join(root, "workspace")
    const binRoot = join(root, "bin")

    try {
      await mkdir(workspace, { recursive: true })
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as RigDeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* RigPackageManagerProvider
          return yield* packages.install({
            deployment,
            service: {
              name: "pantry",
              type: "bin",
              entrypoint: "dist/pantry",
              build: "mkdir -p dist && printf '#!/bin/sh\\necho pantry-cli:$1\\n' > dist/pantry",
            },
          })
        }).pipe(Effect.provide(RigProviderContractsLive("default", [], {
          packageManager: {
            binRoot,
          },
        }))),
      )

      expect(operation).toBe(`package-manager:package-json-scripts:install:pantry:installed:${join(binRoot, "pantry")}`)
      expect(await readFile(join(binRoot, "pantry"), "utf8")).toBe("#!/bin/sh\necho pantry-cli:$1\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const listen = (handler: Parameters<typeof createServer>[0]) =>
  new Promise<{ readonly instance: Server; readonly port: number }>((resolve, reject) => {
    const instance = createServer(handler)
    instance.once("error", reject)
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address()
      if (typeof address === "object" && address !== null) {
        resolve({ instance, port: address.port })
        return
      }
      reject(new Error("HTTP test server did not expose a TCP port."))
    })
  })

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
