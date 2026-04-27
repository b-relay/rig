import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import {
  V2ControlPlaneTransportProvider,
  V2EventTransportProvider,
  V2HealthCheckerProvider,
  V2PackageManagerProvider,
  V2ProcessSupervisorProvider,
  V2ProxyRouterProvider,
  V2ProviderContractsLive,
  V2ProviderRegistry,
  V2ProviderRegistryLive,
  V2ScmProvider,
  V2WorkspaceMaterializerProvider,
  v2ProviderFamilies,
  type V2ProviderPlugin,
} from "./provider-contracts.js"
import type { V2DeploymentRecord } from "./deployments.js"
import { V2FileHomeConfigStoreLive } from "./home-config.js"
import { V2ProviderContractsFromHomeConfigLive } from "./services.js"

const runWithRegistry = <A>(
  effect: Effect.Effect<A, unknown, V2ProviderRegistry>,
  profile: "default" | "stub" | "isolated-e2e",
  externalProviders: readonly V2ProviderPlugin[] = [],
) => Effect.runPromise(effect.pipe(Effect.provide(V2ProviderRegistryLive(profile, externalProviders))))

describe("GIVEN v2 provider plugin contracts WHEN registry reports profiles THEN provider composition is explicit", () => {
  test("GIVEN built-in profiles WHEN reported THEN every profile satisfies the same provider family contract", async () => {
    const reports = await Promise.all([
      runWithRegistry(Effect.gen(function* () {
        const registry = yield* V2ProviderRegistry
        return yield* registry.current
      }), "default"),
      runWithRegistry(Effect.gen(function* () {
        const registry = yield* V2ProviderRegistry
        return yield* registry.current
      }), "stub"),
      runWithRegistry(Effect.gen(function* () {
        const registry = yield* V2ProviderRegistry
        return yield* registry.current
      }), "isolated-e2e"),
    ])

    for (const report of reports) {
      expect(report.families).toEqual(v2ProviderFamilies)
      for (const family of v2ProviderFamilies) {
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
    const cloudflareTunnel: V2ProviderPlugin = {
      id: "cloudflare-tunnel",
      family: "tunnel",
      source: "external",
      displayName: "Cloudflare Tunnel",
      capabilities: ["public-internet", "token-pairing"],
      packageName: "@b-relay/rig-provider-cloudflare-tunnel",
    }

    const report = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* V2ProviderRegistry
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
        const registry = yield* V2ProviderRegistry
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
        const processSupervisor = yield* V2ProcessSupervisorProvider
        const controlPlane = yield* V2ControlPlaneTransportProvider
        const healthChecker = yield* V2HealthCheckerProvider

        return {
          processSupervisor: yield* processSupervisor.plugin,
          controlPlane: yield* controlPlane.plugin,
          healthChecker: yield* healthChecker.plugin,
        }
      }).pipe(Effect.provide(V2ProviderContractsLive("isolated-e2e"))),
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

  test("GIVEN git-worktree materializer WHEN deployment is materialized THEN workspace commands run in isolated v2 paths", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-worktree-"))
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
      } as V2DeploymentRecord

      const [materialized, resolved, removed] = await Effect.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* V2WorkspaceMaterializerProvider
          return [
            yield* workspaces.materialize({ deployment, ref: "feature/a" }),
            yield* workspaces.resolve({ deployment }),
            yield* workspaces.remove({ deployment }),
          ] as const
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
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
    const stateRoot = await mkdtemp(join(tmpdir(), "rig-v2-scm-"))
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
      } as V2DeploymentRecord

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const scm = yield* V2ScmProvider
          return yield* scm.checkout({ deployment, ref: "feature/a" })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
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

  test("GIVEN caddy proxy router WHEN route is upserted and removed THEN v2-managed Caddy blocks are isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-caddy-"))
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
      } as V2DeploymentRecord

      const upserted = await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* V2ProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
          },
        }))),
      )

      const contentAfterUpsert = await readFile(caddyfilePath, "utf8")
      const removed = await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* V2ProxyRouterProvider
          return yield* proxy.remove({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
          },
        }))),
      )
      const contentAfterRemove = await readFile(caddyfilePath, "utf8")

      expect(upserted).toBe("proxy-router:caddy:upsert:feature-a.preview.b-relay.com:web:4173")
      expect(contentAfterUpsert).toContain("manual.example.com")
      expect(contentAfterUpsert).toContain("# [rig2:pantry:feature-a:web]")
      expect(contentAfterUpsert).toContain("feature-a.preview.b-relay.com {")
      expect(contentAfterUpsert).toContain("reverse_proxy http://127.0.0.1:4173")
      expect(removed).toBe("proxy-router:caddy:remove:pantry:feature-a:web")
      expect(contentAfterRemove).toContain("manual.example.com")
      expect(contentAfterRemove).not.toContain("[rig2:pantry:feature-a:web]")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy proxy router WHEN pantry live is routed THEN pantry.b-relay.com points at the selected localhost service", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-pantry-caddy-"))
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
      } as V2DeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* V2ProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
          },
        }))),
      )

      const caddyfile = await readFile(caddyfilePath, "utf8")
      expect(operation).toBe("proxy-router:caddy:upsert:pantry.b-relay.com:web:3070")
      expect(caddyfile).toContain("# [rig2:pantry:live:web]")
      expect(caddyfile).toContain("pantry.b-relay.com {")
      expect(caddyfile).toContain("reverse_proxy http://127.0.0.1:3070")
      expect(caddyfile).not.toContain("import cloudflare")
      expect(caddyfile).not.toContain("import backend_errors")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy proxy router WHEN pantry already exists without a v2 marker THEN upsert adopts the existing site instead of duplicating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-pantry-caddy-adopt-"))
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
      } as V2DeploymentRecord

      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* V2ProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
          proxyRouter: {
            caddyfilePath,
          },
        }))),
      )

      const caddyfile = await readFile(caddyfilePath, "utf8")
      expect(caddyfile.match(/pantry\.b-relay\.com \{/g)).toHaveLength(1)
      expect(caddyfile).toContain("# [rig2:pantry:live:web]")
      expect(caddyfile).toContain("core.b-relay.com {")
      expect(caddyfile).toContain("(cloudflare) {")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN caddy proxy router config WHEN extra config is set THEN it renders inside each managed site block", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-caddy-extra-config-"))
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
      } as V2DeploymentRecord

      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* V2ProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
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
    const root = await mkdtemp(join(tmpdir(), "rig-v2-caddy-reload-command-"))
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
      } as V2DeploymentRecord

      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* V2ProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
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

  test("GIVEN caddy provider settings in v2 home config WHEN default provider contracts are composed THEN routes use those settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-caddy-home-config-"))
    const caddyfilePath = join(root, "system-Caddyfile")
    const previousRoot = process.env.RIG_V2_ROOT
    process.env.RIG_V2_ROOT = root

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
      } as V2DeploymentRecord

      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* V2ProxyRouterProvider
          return yield* proxy.upsert({
            deployment,
            proxy: {
              upstream: "web",
            },
          })
        }).pipe(Effect.provide(Layer.provide(
          V2ProviderContractsFromHomeConfigLive,
          V2FileHomeConfigStoreLive,
        ))),
      )

      const caddyfile = await readFile(caddyfilePath, "utf8")
      expect(caddyfile).toContain("pantry.b-relay.com {")
      expect(caddyfile).toContain("\timport cloudflare")
    } finally {
      if (previousRoot === undefined) {
        delete process.env.RIG_V2_ROOT
      } else {
        process.env.RIG_V2_ROOT = previousRoot
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN launchd process supervisor WHEN lifecycle operations run THEN v2 launchd plists are installed and removed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-v2-launchd-workspace-"))
    const home = await mkdtemp(join(tmpdir(), "rig-v2-launchd-home-"))
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
      } as V2DeploymentRecord

      const up = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* V2ProcessSupervisorProvider
          return yield* processSupervisor.up({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: 3070,
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
          launchd: {
            home,
            runCommand: async (args) => {
              commands.push([...args])
              return { stdout: "", stderr: "", exitCode: 0 }
            },
          },
        }))),
      )

      const label = "com.b-relay.rig2.pantry.live.web"
      const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`)
      const plist = await readFile(plistPath, "utf8")

      const down = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* V2ProcessSupervisorProvider
          return yield* processSupervisor.down({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: 3070,
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
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

  test("GIVEN a deployment-selected process supervisor WHEN executing operations THEN bundled providers share the same interface", async () => {
    const home = await mkdtemp(join(tmpdir(), "rig-v2-launchd-interface-"))

    const deployment = {
      project: "pantry",
      kind: "live",
      name: "live",
      workspacePath: "/tmp/rig-v2/workspaces/pantry/live",
      logRoot: join(home, "logs"),
      resolved: {
        providers: {
          processSupervisor: "launchd",
        },
      },
    } as V2DeploymentRecord

    try {
      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* V2ProcessSupervisorProvider
          return yield* processSupervisor.up({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: 3070,
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
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

  test("GIVEN rigd process supervisor WHEN command exits quickly THEN stdout and stderr are returned as provider output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-v2-rigd-process-"))

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
      } as V2DeploymentRecord

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const processSupervisor = yield* V2ProcessSupervisorProvider
          return yield* processSupervisor.up({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "printf 'ready\\n'; printf 'warn\\n' >&2",
              port: 3070,
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default"))),
      )

      expect(result).toEqual({
        operation: "process-supervisor:rigd:up:web:exited:0",
        output: [
          { stream: "stdout", line: "ready" },
          { stream: "stderr", line: "warn" },
        ],
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN structured-log-file event transport WHEN appending THEN it writes deployment JSONL", async () => {
    const logRoot = await mkdtemp(join(tmpdir(), "rig-v2-provider-events-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        logRoot,
      } as V2DeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* V2EventTransportProvider
          return yield* events.append({
            deployment,
            event: "component.log",
            component: "web",
            details: {
              line: "started",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default"))),
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
      } as V2DeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* V2HealthCheckerProvider
          return yield* health.check({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: server.port,
              healthCheck: `http://127.0.0.1:${server.port}/health`,
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default"))),
      )

      expect(operation).toBe("health-checker:native-health:check:web:healthy:204")
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
      } as V2DeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* V2HealthCheckerProvider
          return yield* health.check({
            deployment,
            service: {
              name: "web",
              type: "server",
              command: "bun run start",
              port: server.port,
              healthCheck: `http://127.0.0.1:${server.port}/health`,
            },
          })
        }).pipe(
          Effect.provide(V2ProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "V2RuntimeError",
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
    const workspace = await mkdtemp(join(tmpdir(), "rig-v2-command-health-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as V2DeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* V2HealthCheckerProvider
          return yield* health.check({
            deployment,
            service: {
              name: "worker",
              type: "server",
              command: "bun run worker",
              healthCheck: "printf ready",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default"))),
      )

      expect(operation).toBe("health-checker:native-health:check:worker:command:healthy:0")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("GIVEN native-health provider WHEN command check exits nonzero THEN it returns a tagged runtime error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-v2-command-health-fail-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as V2DeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const health = yield* V2HealthCheckerProvider
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
          Effect.provide(V2ProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "V2RuntimeError",
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

  test("GIVEN package-json-scripts provider WHEN installed component has build command THEN it runs in the deployment workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-package-install-"))
    const workspace = join(root, "workspace")
    const binRoot = join(root, "bin")

    try {
      await mkdir(workspace, { recursive: true })
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as V2DeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* V2PackageManagerProvider
          return yield* packages.install({
            deployment,
            service: {
              name: "tool",
              type: "bin",
              entrypoint: "dist/tool",
              build: "mkdir -p dist && printf built > dist/tool",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
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

  test("GIVEN package-json-scripts provider WHEN build command fails THEN it returns a tagged runtime error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rig-v2-package-install-fail-"))

    try {
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as V2DeploymentRecord

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* V2PackageManagerProvider
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
          Effect.provide(V2ProviderContractsLive("default")),
          Effect.flip,
        ),
      )

      expect(error).toMatchObject({
        _tag: "V2RuntimeError",
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

  test("GIVEN package-json-scripts provider WHEN pantry CLI is built THEN it installs the pantry executable into the v2 bin root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-v2-pantry-cli-"))
    const workspace = join(root, "workspace")
    const binRoot = join(root, "bin")

    try {
      await mkdir(workspace, { recursive: true })
      const deployment = {
        project: "pantry",
        kind: "live",
        name: "live",
        workspacePath: workspace,
      } as V2DeploymentRecord

      const operation = await Effect.runPromise(
        Effect.gen(function* () {
          const packages = yield* V2PackageManagerProvider
          return yield* packages.install({
            deployment,
            service: {
              name: "pantry",
              type: "bin",
              entrypoint: "dist/pantry",
              build: "mkdir -p dist && printf '#!/bin/sh\\necho pantry-cli:$1\\n' > dist/pantry",
            },
          })
        }).pipe(Effect.provide(V2ProviderContractsLive("default", [], {
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
