import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runDeployCommand } from "./deploy.js"
import { versionHistoryPath } from "./state-paths.js"
import { BinInstaller, type BinInstaller as BinInstallerService } from "../interfaces/bin-installer.js"
import { EnvLoader, type EnvLoader as EnvLoaderService } from "../interfaces/env-loader.js"
import { Git, type Git as GitService } from "../interfaces/git.js"
import { HealthChecker, type HealthCheckConfig, type HealthChecker as HealthCheckerService, type HealthResult } from "../interfaces/health-checker.js"
import { HookRunner, type HookRunResult, type HookRunner as HookRunnerService } from "../interfaces/hook-runner.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import { PortChecker, type PortChecker as PortCheckerService } from "../interfaces/port-checker.js"
import {
  ProcessManager,
  type DaemonConfig,
  type DaemonStatus,
  type ProcessManager as ProcessManagerService,
} from "../interfaces/process-manager.js"
import {
  Registry,
  type Registry as RegistryService,
} from "../interfaces/registry.js"
import {
  ReverseProxy,
  type ProxyChange,
  type ProxyDiff,
  type ProxyEntry,
  type ReverseProxy as ReverseProxyService,
} from "../interfaces/reverse-proxy.js"
import {
  ServiceRunner,
  type HealthStatus,
  type RunOpts,
  type RunningService,
  type ServiceRunner as ServiceRunnerService,
} from "../interfaces/service-runner.js"
import { Workspace, type Workspace as WorkspaceService, type WorkspaceInfo } from "../interfaces/workspace.js"

const PREVIOUS_RIG_ROOT = process.env.RIG_ROOT

afterEach(() => {
  if (PREVIOUS_RIG_ROOT === undefined) {
    delete process.env.RIG_ROOT
  } else {
    process.env.RIG_ROOT = PREVIOUS_RIG_ROOT
  }
})
import { NodeFileSystemLive } from "../providers/node-fs.js"
import type { ServerService } from "../schema/config.js"
import { ConfigValidationError, GitError, MainBranchDetectionError, ProcessError, ProxyError, WorkspaceError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly warnings: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []

  info(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  warn(message: string, details?: Record<string, unknown>) {
    this.warnings.push({ message, details })
    return Effect.void
  }

  error(_structured: RigError) {
    return Effect.void
  }

  success(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  table(_rows: readonly Record<string, unknown>[]) {
    return Effect.void
  }
}

class StaticRegistry implements RegistryService {
  constructor(private readonly repoPath: string) {}

  register(_name: string, _repoPath: string) {
    return Effect.void
  }

  unregister(_name: string) {
    return Effect.void
  }

  resolve(_name: string) {
    return Effect.succeed(this.repoPath)
  }

  list() {
    return Effect.succeed([])
  }
}

class CaptureWorkspace implements WorkspaceService {
  readonly createCalls: Array<{ readonly name: string; readonly env: "dev" | "prod"; readonly version: string; readonly commitRef: string }> = []
  readonly syncCalls: Array<{ readonly name: string; readonly env: "dev" | "prod" }> = []
  readonly resolveCalls: Array<{ readonly name: string; readonly env: "dev" | "prod"; readonly version?: string }> = []
  readonly activateCalls: Array<{ readonly name: string; readonly env: "dev" | "prod"; readonly version: string }> = []
  readonly removeCalls: Array<{ readonly name: string; readonly env: "dev" | "prod"; readonly version: string }> = []
  readonly renameCalls: Array<{ readonly name: string; readonly env: "dev" | "prod"; readonly fromVersion: string; readonly toVersion: string }> = []

  constructor(private readonly resolvedPath: string) {}

  create(name: string, env: "dev" | "prod", version: string, commitRef: string) {
    this.createCalls.push({ name, env, version, commitRef })
    return Effect.succeed(this.resolvedPath)
  }

  resolve(name: string, env: "dev" | "prod", version?: string) {
    this.resolveCalls.push({ name, env, version })
    return Effect.succeed(this.resolvedPath)
  }

  activate(name: string, env: "dev" | "prod", version: string) {
    this.activateCalls.push({ name, env, version })
    return Effect.succeed(this.resolvedPath)
  }

  removeVersion(name: string, env: "dev" | "prod", version: string) {
    this.removeCalls.push({ name, env, version })
    return Effect.void
  }

  renameVersion(name: string, env: "dev" | "prod", fromVersion: string, toVersion: string) {
    this.renameCalls.push({ name, env, fromVersion, toVersion })
    return Effect.succeed(this.resolvedPath)
  }

  sync(name: string, env: "dev" | "prod") {
    this.syncCalls.push({ name, env })
    return Effect.void
  }

  list(_name: string) {
    return Effect.succeed([] as readonly WorkspaceInfo[])
  }
}

class CaptureReverseProxy implements ReverseProxyService {
  readonly addCalls: ProxyEntry[] = []
  readonly updateCalls: ProxyEntry[] = []
  readonly removeCalls: Array<{ readonly name: string; readonly env: string }> = []

  constructor(private readonly entries: readonly ProxyEntry[]) {}

  read() {
    return Effect.succeed(this.entries)
  }

  add(entry: ProxyEntry) {
    this.addCalls.push(entry)
    return Effect.succeed({ type: "added", entry } satisfies ProxyChange)
  }

  update(entry: ProxyEntry) {
    this.updateCalls.push(entry)
    return Effect.succeed({ type: "updated", entry } satisfies ProxyChange)
  }

  remove(name: string, env: string) {
    this.removeCalls.push({ name, env })
    return Effect.succeed({
      type: "removed",
      entry: {
        name,
        env: env as ProxyEntry["env"],
        domain: "",
        upstream: "",
        port: 0,
      },
    } satisfies ProxyChange)
  }

  diff() {
    return Effect.succeed({ changes: [], unchanged: this.entries } satisfies ProxyDiff)
  }

  backup() {
    return Effect.succeed("/tmp/Caddyfile.backup")
  }
}

class CaptureProcessManager implements ProcessManagerService {
  readonly installCalls: DaemonConfig[] = []
  readonly uninstallCalls: string[] = []

  install(config: DaemonConfig) {
    this.installCalls.push(config)
    return Effect.void
  }

  uninstall(label: string) {
    this.uninstallCalls.push(label)
    return Effect.void
  }

  start(_label: string) {
    return Effect.void
  }

  stop(_label: string) {
    return Effect.void
  }

  status(label: string) {
    return Effect.succeed({
      label,
      loaded: false,
      running: false,
      pid: null,
    } satisfies DaemonStatus)
  }

  backup(_label: string) {
    return Effect.succeed("/tmp/backup.plist")
  }
}

class StaticServiceRunner implements ServiceRunnerService {
  private nextPid = 41000

  start(service: ServerService, _opts: RunOpts) {
    this.nextPid += 1
    return Effect.succeed({
      name: service.name,
      pid: this.nextPid,
      port: service.port,
      startedAt: new Date(),
    } satisfies RunningService)
  }

  stop(_service: RunningService) {
    return Effect.void
  }

  health(_service: RunningService): Effect.Effect<HealthStatus, never> {
    return Effect.succeed("healthy")
  }

  logs(_service: string, _opts: { readonly follow: boolean; readonly lines: number; readonly service?: string; readonly workspacePath?: string }) {
    return Effect.succeed("")
  }
}

class StaticHookRunner implements HookRunnerService {
  runHook(_command: string, _opts: { readonly workdir: string; readonly env: Readonly<Record<string, string>> }) {
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" } satisfies HookRunResult)
  }
}

class StaticPortChecker implements PortCheckerService {
  check(_port: number, _service: string) {
    return Effect.void
  }
}

class StaticHealthChecker implements HealthCheckerService {
  check(config: HealthCheckConfig) {
    return Effect.succeed({
      healthy: true,
      responseTime: 0,
      statusCode: config.type === "http" ? 200 : null,
      message: "ok",
    } satisfies HealthResult)
  }

  poll(config: HealthCheckConfig, _interval: number, _timeout: number) {
    return this.check(config)
  }
}

class StaticEnvLoader implements EnvLoaderService {
  load(_envFile: string, _workdir: string) {
    return Effect.succeed({} as Readonly<Record<string, string>>)
  }
}

class StaticBinInstaller implements BinInstallerService {
  build(config: { readonly name: string }, workdir: string) {
    return Effect.succeed(join(workdir, config.name))
  }

  install(name: string, _env: string, binaryPath: string) {
    return Effect.succeed(`${binaryPath}:${name}`)
  }

  uninstall(_name: string, _env: string) {
    return Effect.void
  }
}

class StaticGit implements GitService {
  readonly createdTags: string[] = []
  readonly deletedTags: string[] = []

  constructor(
    private readonly branch = "main",
    private readonly commitValue = "head-sha",
    private readonly ancestry = true,
    private readonly tagsOnHead: readonly string[] = [],
  ) {}

  detectMainBranch(_repoPath: string): Effect.Effect<string, MainBranchDetectionError | GitError> {
    return Effect.succeed("main")
  }

  isDirty(_repoPath: string): Effect.Effect<boolean, GitError> {
    return Effect.succeed(false)
  }

  currentBranch(_repoPath: string): Effect.Effect<string, GitError> {
    return Effect.succeed(this.branch)
  }

  commitHash(_repoPath: string, ref?: string): Effect.Effect<string, GitError> {
    if (ref?.startsWith("v")) {
      return Effect.succeed(ref === "v1.2.3" ? "head-sha" : "older-sha")
    }
    return Effect.succeed(this.commitValue)
  }

  changedFiles(_repoPath: string): Effect.Effect<readonly string[], GitError> {
    return Effect.succeed([])
  }

  commit(_repoPath: string, _message: string, _paths?: readonly string[]): Effect.Effect<void, GitError> {
    return Effect.void
  }

  createTag(_repoPath: string, tag: string): Effect.Effect<void, GitError> {
    this.createdTags.push(tag)
    return Effect.void
  }

  createTagAtRef(_repoPath: string, tag: string, _ref: string): Effect.Effect<void, GitError> {
    this.createdTags.push(tag)
    return Effect.void
  }

  deleteTag(_repoPath: string, tag: string): Effect.Effect<void, GitError> {
    this.deletedTags.push(tag)
    return Effect.void
  }

  tagExists(_repoPath: string, _tag: string): Effect.Effect<boolean, GitError> {
    return Effect.succeed(false)
  }

  listTags(_repoPath: string): Effect.Effect<readonly string[], GitError> {
    return Effect.succeed([])
  }

  commitHasTag(_repoPath: string, _commit: string): Effect.Effect<string | null, GitError> {
    return Effect.succeed(this.tagsOnHead[0] ?? null)
  }

  commitTags(_repoPath: string, _commit: string): Effect.Effect<readonly string[], GitError> {
    return Effect.succeed(this.tagsOnHead)
  }

  isAncestor(_repoPath: string, _ancestorRef: string, _descendantRef: string): Effect.Effect<boolean, GitError> {
    return Effect.succeed(this.ancestry)
  }

  createWorktree(_repoPath: string, _dest: string, _ref: string): Effect.Effect<void, GitError> {
    return Effect.void
  }

  removeWorktree(_repoPath: string, _dest: string): Effect.Effect<void, GitError> {
    return Effect.void
  }

  moveWorktree(_repoPath: string, _src: string, _dest: string): Effect.Effect<void, GitError> {
    return Effect.void
  }
}

const writeRigConfig = async (repoPath: string, config: unknown) => {
  await mkdir(repoPath, { recursive: true })
  await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

const runtimeLayer = () =>
  Layer.mergeAll(
    Layer.succeed(ServiceRunner, new StaticServiceRunner()),
    Layer.succeed(HealthChecker, new StaticHealthChecker()),
    Layer.succeed(HookRunner, new StaticHookRunner()),
    Layer.succeed(PortChecker, new StaticPortChecker()),
    Layer.succeed(EnvLoader, new StaticEnvLoader()),
    Layer.succeed(BinInstaller, new StaticBinInstaller()),
  )

const runTestEffect = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

describe("GIVEN suite context WHEN deploy command orchestration THEN behavior is covered", () => {
  test("GIVEN test setup WHEN dev deploy creates/syncs workspace, adds proxy entry, and installs daemon THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-dev-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      domain: "pantry.example.com",
      daemon: {
        enabled: true,
        keepAlive: true,
      },
      environments: {
        dev: {
          proxy: { upstream: "web" },
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 5173,
            },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.2.3",
      domain: "pantry.example.com",
      daemon: {
        enabled: false,
      },
      environments: {
        prod: {
          proxy: { upstream: "web" },
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 3070,
            },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.2.3",
      domain: "pantry.example.com",
      daemon: {
        enabled: false,
      },
      environments: {
        prod: {
          proxy: { upstream: "web" },
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 3070,
            },
          ],
        },
      },
    })

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(workspace.createCalls).toEqual([
      {
        name: "pantry",
        env: "dev",
        version: "1.2.3",
        commitRef: repoPath,
      },
    ])
    expect(workspace.syncCalls).toEqual([{ name: "pantry", env: "dev" }])
    expect(workspace.resolveCalls).toEqual([
      { name: "pantry", env: "dev", version: undefined },
      { name: "pantry", env: "dev", version: undefined },
    ])
    expect(reverseProxy.addCalls).toEqual([
      {
        name: "pantry",
        env: "dev",
        domain: "dev.pantry.example.com",
        upstream: "web",
        port: 5173,
      },
    ])
    expect(processManager.installCalls).toHaveLength(1)
    expect(processManager.installCalls[0]).toMatchObject({
      label: "rig.pantry.dev",
      command: "rig",
      args: ["start", "pantry", "dev", "--foreground"],
      keepAlive: true,
      workdir: workspacePath,
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN prod deploy uses version tag workspace ref, updates proxy, and uninstalls daemon when disabled THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-prod-"))
    const workspacePath = join(repoPath, ".workspaces", "prod")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      domain: "pantry.example.com",
      daemon: {
        enabled: false,
      },
      environments: {
        prod: {
          proxy: { upstream: "web" },
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 3070,
            },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.2.3",
      domain: "pantry.example.com",
      daemon: {
        enabled: false,
      },
      environments: {
        prod: {
          proxy: { upstream: "web" },
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 3070,
            },
          ],
        },
      },
    })

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([
      {
        name: "pantry",
        env: "prod",
        domain: "pantry.example.com",
        upstream: "web",
        port: 9999,
      },
    ])
    const processManager = new CaptureProcessManager()
    const logger = new CaptureLogger()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(workspace.createCalls).toEqual([
      {
        name: "pantry",
        env: "prod",
        version: "1.2.3",
        commitRef: "v1.2.3",
      },
    ])
    expect(workspace.activateCalls).toEqual([{ name: "pantry", env: "prod", version: "1.2.3" }])
    expect(workspace.resolveCalls).toEqual([
      { name: "pantry", env: "prod", version: "1.2.3" },
      { name: "pantry", env: "prod", version: undefined },
    ])
    expect(reverseProxy.updateCalls).toEqual([
      {
        name: "pantry",
        env: "prod",
        domain: "pantry.example.com",
        upstream: "web",
        port: 3070,
      },
    ])
    expect(processManager.installCalls).toEqual([])
    expect(processManager.uninstallCalls).toEqual(["rig.pantry.prod"])
    expect(logger.warnings).toEqual([])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN no domain config means reverseProxy.add/update are never called THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-nodomain-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(reverseProxy.addCalls).toEqual([])
    expect(reverseProxy.updateCalls).toEqual([])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN proxy upstream referencing non-existent service fails with ConfigValidationError THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-badupstream-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      domain: "pantry.example.com",
      environments: {
        dev: {
          proxy: { upstream: "ghost" },
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.0.0",
      daemon: {
        enabled: true,
        keepAlive: false,
      },
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.0.0",
      daemon: {
        enabled: true,
        keepAlive: false,
      },
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const result = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN proxy upstream referencing a task-type service fails with ConfigValidationError THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-taskupstream-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      domain: "pantry.example.com",
      environments: {
        dev: {
          proxy: { upstream: "cli" },
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
            { name: "cli", type: "bin", entrypoint: "cli/index.ts" },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const result = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left.message).toContain("must reference a server service")
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN existing proxy entry unchanged means no add or update calls THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-proxynochange-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      domain: "pantry.example.com",
      environments: {
        dev: {
          proxy: { upstream: "web" },
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
          ],
        },
      },
    })

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([
      {
        name: "pantry",
        env: "dev",
        domain: "dev.pantry.example.com",
        upstream: "web",
        port: 5173,
      },
    ])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(reverseProxy.addCalls).toEqual([])
    expect(reverseProxy.updateCalls).toEqual([])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN prod workspace already exists is recovered and deploy continues THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-wsexists-"))
    const workspacePath = join(repoPath, ".workspaces", "prod")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })

    class AlreadyExistsWorkspace implements WorkspaceService {
      readonly resolveCalls: Array<{ name: string; env: "dev" | "prod"; version?: string }> = []
      readonly activateCalls: Array<{ name: string; env: "dev" | "prod"; version: string }> = []

      create(_name: string, _env: "dev" | "prod", _version: string, _commitRef: string) {
        return Effect.fail(
          new WorkspaceError("create", _name, _env, `Workspace already exists at ${workspacePath}`, "Use rig deploy --force to replace."),
        )
      }

      resolve(name: string, env: "dev" | "prod", version?: string) {
        this.resolveCalls.push({ name, env, version })
        return Effect.succeed(workspacePath)
      }

      activate(name: string, env: "dev" | "prod", version: string) {
        this.activateCalls.push({ name, env, version })
        return Effect.succeed(workspacePath)
      }

      removeVersion(_name: string, _env: "dev" | "prod", _version: string) {
        return Effect.void
      }

      renameVersion(_name: string, _env: "dev" | "prod", _fromVersion: string, _toVersion: string) {
        return Effect.succeed(workspacePath)
      }

      sync(_name: string, _env: "dev" | "prod") {
        return Effect.void
      }

      list(_name: string) {
        return Effect.succeed([
          {
            name: "pantry",
            env: "prod" as const,
            version: "1.0.0",
            path: workspacePath,
            active: true,
          },
        ])
      }
    }

    const workspace = new AlreadyExistsWorkspace()
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new CaptureProcessManager()
    const logger = new CaptureLogger()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(workspace.resolveCalls).toEqual([
      { name: "pantry", env: "prod", version: "1.0.0" },
      { name: "pantry", env: "prod", version: undefined },
    ])
    expect(logger.warnings).toEqual([
      {
        message: "Redeploying existing tagged prod version.",
        details: {
          name: "pantry",
          env: "prod",
          version: "1.0.0",
          tag: "v1.0.0",
          hint: "This redeploy uses the existing tag for version 1.0.0.",
        },
      },
    ])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN daemon disabled with no existing plist (ENOENT) is recovered and deploy continues THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-noplist-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      daemon: { enabled: false },
      environments: {
        dev: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
          ],
        },
      },
    })

    class EnoentProcessManager implements ProcessManagerService {
      readonly installCalls: DaemonConfig[] = []

      install(config: DaemonConfig) {
        this.installCalls.push(config)
        return Effect.void
      }

      uninstall(label: string) {
        return Effect.fail(
          new ProcessError("uninstall", label, `ENOENT: no such file or directory, open '/Users/test/Library/LaunchAgents/${label}.plist'`, "No plist to remove."),
        )
      }

      start(_label: string) {
        return Effect.void
      }

      stop(_label: string) {
        return Effect.void
      }

      status(label: string) {
        return Effect.succeed({
          label,
          loaded: false,
          running: false,
          pid: null,
        } satisfies DaemonStatus)
      }

      backup(_label: string) {
        return Effect.succeed("/tmp/backup.plist")
      }
    }

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new EnoentProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(processManager.installCalls).toEqual([])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN dev deploy WHEN workspace create fails with non already-exists error THEN WorkspaceError propagates", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-workspace-create-fail-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
          ],
        },
      },
    })

    class PermissionDeniedWorkspace implements WorkspaceService {
      create(name: string, env: "dev" | "prod", _version: string, _commitRef: string) {
        return Effect.fail(
          new WorkspaceError(
            "create",
            name,
            env,
            "Permission denied while creating workspace.",
            "Grant write permissions and retry.",
          ),
        )
      }

      resolve(_name: string, _env: "dev" | "prod", _version?: string) {
        return Effect.succeed(workspacePath)
      }

      activate(_name: string, _env: "dev" | "prod", _version: string) {
        return Effect.succeed(workspacePath)
      }

      removeVersion(_name: string, _env: "dev" | "prod", _version: string) {
        return Effect.void
      }

      renameVersion(_name: string, _env: "dev" | "prod", _fromVersion: string, _toVersion: string) {
        return Effect.succeed(workspacePath)
      }

      sync(_name: string, _env: "dev" | "prod") {
        return Effect.void
      }

      list(_name: string) {
        return Effect.succeed([])
      }
    }

    const workspace = new PermissionDeniedWorkspace()
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const result = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WorkspaceError)
      const error = result.left as WorkspaceError
      expect(error.operation).toBe("create")
      expect(error.message).toContain("Permission denied")
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN dev deploy WHEN reverse proxy add fails THEN ProxyError propagates", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-proxy-add-fail-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      domain: "pantry.example.com",
      environments: {
        dev: {
          proxy: { upstream: "web" },
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
          ],
        },
      },
    })

    class FailingAddReverseProxy implements ReverseProxyService {
      readonly addCalls: ProxyEntry[] = []
      readonly updateCalls: ProxyEntry[] = []

      read() {
        return Effect.succeed([] as const)
      }

      add(entry: ProxyEntry) {
        this.addCalls.push(entry)
        return Effect.fail(
          new ProxyError("add", "Failed to write reverse proxy entry.", "Fix proxy configuration access."),
        )
      }

      update(entry: ProxyEntry) {
        this.updateCalls.push(entry)
        return Effect.succeed({ type: "updated", entry } satisfies ProxyChange)
      }

      remove(_name: string, _env: string) {
        return Effect.fail(
          new ProxyError("remove", "remove not implemented in test double", "unused"),
        )
      }

      diff() {
        return Effect.succeed({ changes: [], unchanged: [] } satisfies ProxyDiff)
      }

      backup() {
        return Effect.succeed("/tmp/Caddyfile.backup")
      }
    }

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new FailingAddReverseProxy()
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const result = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ProxyError)
      const error = result.left as ProxyError
      expect(error.operation).toBe("add")
      expect(error.message).toContain("Failed to write reverse proxy entry")
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN prod deploy WHEN process manager install fails THEN ProcessError propagates", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-daemon-install-fail-"))
    const workspacePath = join(repoPath, ".workspaces", "prod")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      daemon: {
        enabled: true,
        keepAlive: false,
      },
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.0.0",
      daemon: {
        enabled: true,
        keepAlive: false,
      },
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })

    class FailingInstallProcessManager implements ProcessManagerService {
      readonly installCalls: DaemonConfig[] = []

      install(config: DaemonConfig) {
        this.installCalls.push(config)
        return Effect.fail(
          new ProcessError(
            "install",
            config.label,
            "launchctl returned a failure while loading plist.",
            "Inspect launchctl output and retry.",
          ),
        )
      }

      uninstall(_label: string) {
        return Effect.void
      }

      start(_label: string) {
        return Effect.void
      }

      stop(_label: string) {
        return Effect.void
      }

      status(label: string) {
        return Effect.succeed({
          label,
          loaded: false,
          running: false,
          pid: null,
        } satisfies DaemonStatus)
      }

      backup(_label: string) {
        return Effect.succeed("/tmp/backup.plist")
      }
    }

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new FailingInstallProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const result = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ProcessError)
      const error = result.left as ProcessError
      expect(error.operation).toBe("install")
      expect(error.label).toBe("rig.pantry.prod")
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN dev deploy WHEN domain exists but environment proxy config is missing THEN reverse proxy add and update are not called", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-domain-no-proxy-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      domain: "pantry.example.com",
      environments: {
        dev: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
          ],
        },
      },
    })

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(reverseProxy.addCalls).toEqual([])
    expect(reverseProxy.updateCalls).toEqual([])
    expect(reverseProxy.removeCalls).toEqual([])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN stale proxy entry WHEN deploy has no proxy configuration THEN reverse proxy entry is removed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-remove-stale-proxy-"))
    const workspacePath = join(repoPath, ".workspaces", "dev")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
          ],
        },
      },
    })

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([
      {
        name: "pantry",
        env: "dev",
        domain: "dev.pantry.example.com",
        upstream: "web",
        port: 5173,
      },
    ])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(reverseProxy.addCalls).toEqual([])
    expect(reverseProxy.updateCalls).toEqual([])
    expect(reverseProxy.removeCalls).toEqual([{ name: "pantry", env: "dev" }])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN prod deploy WHEN daemon config is missing entirely THEN uninstall is called as disabled behavior", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-daemon-missing-"))
    const workspacePath = join(repoPath, ".workspaces", "prod")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
          ],
        },
      },
    })

    const workspace = new CaptureWorkspace(workspacePath)
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(processManager.installCalls).toEqual([])
    expect(processManager.uninstallCalls).toEqual(["rig.pantry.prod"])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN prod minor release deploy WHEN branch matches deployBranch THEN version tag is created and prod deploy succeeds", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-release-minor-"))
    const workspacePath = join(repoPath, ".workspaces", "prod-release")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        prod: {
          deployBranch: "main",
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 3070,
            },
          ],
        },
      },
    })
    await writeRigConfig(workspacePath, {
      name: "pantry",
      version: "1.3.0",
      environments: {
        prod: {
          deployBranch: "main",
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 3070,
            },
          ],
        },
      },
    })

    const logger = new CaptureLogger()
    const workspace = new CaptureWorkspace(workspacePath)
    const git = new StaticGit("main")
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, new CaptureReverseProxy([])),
      Layer.succeed(ProcessManager, new CaptureProcessManager()),
      Layer.succeed(Git, git),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "prod", bump: "minor" }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(exitCode).toBe(0)
    expect(git.createdTags).toEqual(["v1.3.0"])
    expect(workspace.activateCalls).toEqual([{ name: "pantry", env: "prod", version: "1.3.0" }])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN HEAD already has a release tag WHEN prod bump deploy runs THEN it fails before creating another version", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-release-already-tagged-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        prod: {
          deployBranch: "main",
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 3070,
            },
          ],
        },
      },
    })

    const git = new StaticGit("main", "head-sha", true, ["v1.2.3"])
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new CaptureWorkspace(join(repoPath, ".workspaces", "prod-release"))),
      Layer.succeed(ReverseProxy, new CaptureReverseProxy([])),
      Layer.succeed(ProcessManager, new CaptureProcessManager()),
      Layer.succeed(Git, git),
      runtimeLayer(),
    )

    const result = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "prod", bump: "minor" }).pipe(
        Effect.provide(layer),
        Effect.either,
      ),
    )

    expect(result._tag).toBe("Left")
    expect(git.createdTags).toEqual([])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN latest prod release is not active WHEN revert runs THEN metadata is removed and runtime stays pinned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-revert-pinned-"))
    process.env.RIG_ROOT = join(repoPath, ".rig-state")
    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.1.0",
      environments: {
        prod: {
          deployBranch: "main",
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 3070,
            },
          ],
        },
      },
    })
    await mkdir(dirname(versionHistoryPath("pantry")), { recursive: true })
    await writeFile(
      versionHistoryPath("pantry"),
      `${JSON.stringify(
        {
          name: "pantry",
          entries: [
            {
              action: "patch",
              oldVersion: "1.0.0",
              newVersion: "1.0.1",
              changedAt: "2026-03-09T00:00:00.000Z",
            },
            {
              action: "minor",
              oldVersion: "1.0.1",
              newVersion: "1.1.0",
              changedAt: "2026-03-09T01:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    class PinnedWorkspace extends CaptureWorkspace {
      override list(_name: string) {
        return Effect.succeed([
          {
            name: "pantry",
            env: "prod" as const,
            version: "1.0.1",
            path: join(repoPath, ".workspaces", "prod", "1.0.1"),
            active: true,
          },
          {
            name: "pantry",
            env: "prod" as const,
            version: "1.1.0",
            path: join(repoPath, ".workspaces", "prod", "1.1.0"),
            active: false,
          },
        ])
      }
    }

    const logger = new CaptureLogger()
    const workspace = new PinnedWorkspace(join(repoPath, ".workspaces", "prod"))
    const git = new StaticGit("main")
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, new CaptureReverseProxy([])),
      Layer.succeed(ProcessManager, new CaptureProcessManager()),
      Layer.succeed(Git, git),
      runtimeLayer(),
    )

    const exitCode = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "prod", revert: "1.1.0" }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(exitCode).toBe(0)
    expect(workspace.removeCalls).toEqual([{ name: "pantry", env: "prod", version: "1.1.0" }])
    expect(logger.warnings).toContainEqual({
      message: "Reverted latest prod release without changing active runtime.",
      details: {
        name: "pantry",
        revertedVersion: "1.1.0",
        activeVersion: "1.0.1",
        restoredLatestVersion: "1.0.1",
        hint: "Because you're on a set version, no rollback was performed.",
      },
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN prod release deploy WHEN current branch does not match deployBranch THEN deploy fails before tagging", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-deploy-release-branch-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        prod: {
          deployBranch: "main",
          services: [
            {
              name: "web",
              type: "server",
              command: "echo web",
              port: 3070,
            },
          ],
        },
      },
    })

    const git = new StaticGit("feature/fix")
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new CaptureWorkspace(join(repoPath, ".workspaces", "prod-release"))),
      Layer.succeed(ReverseProxy, new CaptureReverseProxy([])),
      Layer.succeed(ProcessManager, new CaptureProcessManager()),
      Layer.succeed(Git, git),
      runtimeLayer(),
    )

    const result = await runTestEffect(
      runDeployCommand({ name: "pantry", env: "prod", bump: "patch" }).pipe(
        Effect.provide(layer),
        Effect.either,
      ),
    )

    expect(result._tag).toBe("Left")
    expect(git.createdTags).toEqual([])

    await rm(repoPath, { recursive: true, force: true })
  })
})
