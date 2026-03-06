import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runDeployCommand } from "./deploy.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
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
import { Workspace, type Workspace as WorkspaceService } from "../interfaces/workspace.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { ConfigValidationError, ProcessError, ProxyError, WorkspaceError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  info(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  warn(_message: string, _details?: Record<string, unknown>) {
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
  readonly resolveCalls: Array<{ readonly name: string; readonly env: "dev" | "prod" }> = []

  constructor(private readonly resolvedPath: string) {}

  create(name: string, env: "dev" | "prod", version: string, commitRef: string) {
    this.createCalls.push({ name, env, version, commitRef })
    return Effect.succeed(this.resolvedPath)
  }

  resolve(name: string, env: "dev" | "prod") {
    this.resolveCalls.push({ name, env })
    return Effect.succeed(this.resolvedPath)
  }

  sync(name: string, env: "dev" | "prod") {
    this.syncCalls.push({ name, env })
    return Effect.void
  }

  list(_name: string) {
    return Effect.succeed([])
  }
}

class CaptureReverseProxy implements ReverseProxyService {
  readonly addCalls: ProxyEntry[] = []
  readonly updateCalls: ProxyEntry[] = []

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

  remove(_name: string, _env: string) {
    return Effect.fail(
      new ProxyError("remove", "remove not implemented in test double", "unused"),
    )
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

const writeRigConfig = async (repoPath: string, config: unknown) => {
  await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

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
    )

    const exitCode = await Effect.runPromise(
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
    expect(workspace.resolveCalls).toEqual([{ name: "pantry", env: "dev" }])
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
      args: ["start", "pantry", "--dev", "--foreground"],
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

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
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
    expect(workspace.resolveCalls).toEqual([{ name: "pantry", env: "prod" }])
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
    )

    const exitCode = await Effect.runPromise(
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
    )

    const result = await Effect.runPromise(
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
    )

    const result = await Effect.runPromise(
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
    )

    const exitCode = await Effect.runPromise(
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

    class AlreadyExistsWorkspace implements WorkspaceService {
      readonly resolveCalls: Array<{ name: string; env: "dev" | "prod" }> = []

      create(_name: string, _env: "dev" | "prod", _version: string, _commitRef: string) {
        return Effect.fail(
          new WorkspaceError("create", _name, _env, `Workspace already exists at ${workspacePath}`, "Use rig deploy --force to replace."),
        )
      }

      resolve(name: string, env: "dev" | "prod") {
        this.resolveCalls.push({ name, env })
        return Effect.succeed(workspacePath)
      }

      sync(_name: string, _env: "dev" | "prod") {
        return Effect.void
      }

      list(_name: string) {
        return Effect.succeed([])
      }
    }

    const workspace = new AlreadyExistsWorkspace()
    const reverseProxy = new CaptureReverseProxy([])
    const processManager = new CaptureProcessManager()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, workspace),
      Layer.succeed(ReverseProxy, reverseProxy),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
      runDeployCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(workspace.resolveCalls).toEqual([{ name: "pantry", env: "prod" }])

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
    )

    const exitCode = await Effect.runPromise(
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

      resolve(_name: string, _env: "dev" | "prod") {
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
    )

    const result = await Effect.runPromise(
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
    )

    const result = await Effect.runPromise(
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
    )

    const result = await Effect.runPromise(
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
    )

    const exitCode = await Effect.runPromise(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(reverseProxy.addCalls).toEqual([])
    expect(reverseProxy.updateCalls).toEqual([])

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
    )

    const exitCode = await Effect.runPromise(
      runDeployCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(processManager.installCalls).toEqual([])
    expect(processManager.uninstallCalls).toEqual(["rig.pantry.prod"])

    await rm(repoPath, { recursive: true, force: true })
  })
})
