import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v3"

import { runForgetCommand } from "./forget.js"
import { rigBinPath, rigVersionHistoryPath, rigWorkspacesRoot } from "./rig-paths.js"
import { BinInstaller, type BinInstaller as BinInstallerService } from "../interfaces/bin-installer.js"
import { EnvLoader, type EnvLoader as EnvLoaderService } from "../interfaces/env-loader.js"
import { FileSystem } from "../interfaces/file-system.js"
import { HookRunner, type HookRunner as HookRunnerService } from "../interfaces/hook-runner.js"
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
  type RegistryEntry,
} from "../interfaces/registry.js"
import { ReverseProxy, type ProxyChange, type ProxyDiff, type ProxyEntry, type ReverseProxy as ReverseProxyService } from "../interfaces/reverse-proxy.js"
import { ServiceRunner, type RunningService, type RunOpts, type ServiceRunner as ServiceRunnerService } from "../interfaces/service-runner.js"
import { Workspace, type Workspace as WorkspaceService, type WorkspaceInfo } from "../interfaces/workspace.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import type { ServerService } from "../schema/config.js"
import { RegistryError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly warnings: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []

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

  success(message: string, details?: Record<string, unknown>) {
    this.successes.push({ message, details })
    return Effect.void
  }

  table(_rows: readonly Record<string, unknown>[]) {
    return Effect.void
  }
}

class MemoryRegistry implements RegistryService {
  private readonly entries = new Map<string, RegistryEntry>()

  constructor(entries: readonly RegistryEntry[]) {
    for (const entry of entries) {
      this.entries.set(entry.name, entry)
    }
  }

  register(name: string, repoPath: string) {
    this.entries.set(name, { name, repoPath, registeredAt: new Date() })
    return Effect.void
  }

  unregister(name: string) {
    if (!this.entries.has(name)) {
      return Effect.fail(
        new RegistryError("unregister", name, `Project '${name}' is not registered.`, "Run `rig list` first."),
      )
    }

    this.entries.delete(name)
    return Effect.void
  }

  resolve(name: string) {
    const entry = this.entries.get(name)
    return entry
      ? Effect.succeed(entry.repoPath)
      : Effect.fail(
          new RegistryError("resolve", name, `Project '${name}' is not registered.`, "Run `rig list` first."),
        )
  }

  list() {
    return Effect.succeed([...this.entries.values()])
  }
}

class StaticWorkspace implements WorkspaceService {
  constructor(private readonly rows: readonly WorkspaceInfo[]) {}

  create(_name: string, _env: "dev" | "prod", _version: string, _commitRef: string) {
    return Effect.succeed("/tmp/workspace")
  }

  resolve(_name: string, _env: "dev" | "prod", _version?: string) {
    return Effect.succeed("/tmp/workspace")
  }

  activate(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.succeed("/tmp/workspace")
  }

  removeVersion(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.void
  }

  renameVersion(_name: string, _env: "dev" | "prod", _fromVersion: string, _toVersion: string) {
    return Effect.succeed("/tmp/workspace")
  }

  sync(_name: string, _env: "dev" | "prod") {
    return Effect.void
  }

  list(name: string) {
    return Effect.succeed(this.rows.filter((row) => row.name === name))
  }
}

class CaptureProcessManager implements ProcessManagerService {
  readonly uninstallCalls: string[] = []

  install(_config: DaemonConfig) {
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
    return Effect.succeed({ label, loaded: false, running: false, pid: null } satisfies DaemonStatus)
  }

  backup(_label: string) {
    return Effect.succeed("/tmp/backup.plist")
  }
}

class CaptureReverseProxy implements ReverseProxyService {
  readonly removeCalls: Array<{ readonly name: string; readonly env: string }> = []

  read() {
    return Effect.succeed([] as readonly ProxyEntry[])
  }

  add(entry: ProxyEntry) {
    return Effect.succeed({ type: "added", entry } satisfies ProxyChange)
  }

  update(entry: ProxyEntry) {
    return Effect.succeed({ type: "updated", entry } satisfies ProxyChange)
  }

  remove(name: string, env: string) {
    this.removeCalls.push({ name, env })
    return Effect.succeed({
      type: "removed",
      entry: { name, env: env as "dev" | "prod", domain: "", upstream: "", port: 0 },
    } satisfies ProxyChange)
  }

  diff() {
    return Effect.succeed({ changes: [], unchanged: [] } satisfies ProxyDiff)
  }

  backup() {
    return Effect.succeed("/tmp/caddy-backup")
  }
}

class StaticServiceRunner implements ServiceRunnerService {
  start(_service: ServerService, _opts: RunOpts) {
    return Effect.succeed({ name: "noop", pid: 1, port: 0, startedAt: new Date(0) } satisfies RunningService)
  }

  stop(_service: RunningService) {
    return Effect.void
  }

  health(_service: RunningService) {
    return Effect.succeed("healthy" as const)
  }

  logs(_service: string) {
    return Effect.succeed("")
  }
}

class StaticHookRunner implements HookRunnerService {
  runHook(_command: string) {
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
  }
}

class StaticEnvLoader implements EnvLoaderService {
  load(_envFile: string, _workdir: string) {
    return Effect.succeed({})
  }
}

class StaticBinInstaller implements BinInstallerService {
  build() {
    return Effect.succeed("/tmp/bin")
  }

  install() {
    return Effect.succeed("/tmp/bin")
  }

  uninstall() {
    return Effect.void
  }
}

const PREVIOUS_RIG_ROOT = process.env.RIG_ROOT

afterEach(() => {
  if (PREVIOUS_RIG_ROOT === undefined) {
    delete process.env.RIG_ROOT
  } else {
    process.env.RIG_ROOT = PREVIOUS_RIG_ROOT
  }
})

describe("GIVEN suite context WHEN forget command executes THEN behavior is covered", () => {
  test("GIVEN registered project WHEN forget runs without purge THEN registry entry is removed but local rig state remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-forget-basic-"))
    process.env.RIG_ROOT = join(root, ".rig-state")
    const repoPath = join(root, "repo")
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, "rig.json"), `${JSON.stringify({ name: "pantry", environments: {} }, null, 2)}\n`)

    const historyPath = rigVersionHistoryPath("pantry")
    await mkdir(dirname(historyPath), { recursive: true })
    await writeFile(historyPath, "{}\n")

    const logger = new CaptureLogger()
    const registry = new MemoryRegistry([
      { name: "pantry", repoPath, registeredAt: new Date(0) },
    ])

    const exitCode = await Effect.runPromise(
      runForgetCommand({ name: "pantry", purge: false }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeFileSystemLive,
            Layer.succeed(Logger, logger),
            Layer.succeed(Registry, registry),
            Layer.succeed(Workspace, new StaticWorkspace([])),
            Layer.succeed(ProcessManager, new CaptureProcessManager()),
            Layer.succeed(ReverseProxy, new CaptureReverseProxy()),
            Layer.succeed(ServiceRunner, new StaticServiceRunner()),
            Layer.succeed(HookRunner, new StaticHookRunner()),
            Layer.succeed(EnvLoader, new StaticEnvLoader()),
            Layer.succeed(BinInstaller, new StaticBinInstaller()),
          ),
        ),
      ),
    )

    expect(exitCode).toBe(0)
    expect(logger.successes.at(-1)?.message).toBe("Project forgotten.")
    expect(await Effect.runPromise(registry.list())).toEqual([])
    expect(await Bun.file(historyPath).exists()).toBe(true)

    await rm(root, { recursive: true, force: true })
  })

  test("GIVEN purge flag WHEN forget runs THEN rig-managed state is removed and project is unregistered", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-forget-purge-"))
    process.env.RIG_ROOT = join(root, ".rig-state")
    const repoPath = join(root, "repo")
    const workspacePath = join(rigWorkspacesRoot(), "pantry", "prod", "0.2.0")
    const shimPath = rigBinPath("cli", "prod")
    await mkdir(repoPath, { recursive: true })
    await mkdir(join(repoPath, ".rig"), { recursive: true })
    await mkdir(workspacePath, { recursive: true })
    await writeFile(
      join(repoPath, "rig.json"),
      `${JSON.stringify(
        {
          name: "pantry",
          version: "0.2.0",
          environments: {
            prod: {
              deployBranch: "main",
              services: [{ name: "cli", type: "bin", entrypoint: "dist/cli" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(join(repoPath, ".rig", "bins.json"), `${JSON.stringify({ cli: { shimPath } }, null, 2)}\n`)
    await mkdir(dirname(shimPath), { recursive: true })
    await writeFile(shimPath, "#!/bin/sh\n", "utf8")

    const historyPath = rigVersionHistoryPath("pantry")
    await mkdir(dirname(historyPath), { recursive: true })
    await writeFile(historyPath, "{}\n")

    const logger = new CaptureLogger()
    const registry = new MemoryRegistry([
      { name: "pantry", repoPath, registeredAt: new Date(0) },
    ])
    const processManager = new CaptureProcessManager()
    const reverseProxy = new CaptureReverseProxy()

    const exitCode = await Effect.runPromise(
      runForgetCommand({ name: "pantry", purge: true }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeFileSystemLive,
            Layer.succeed(Logger, logger),
            Layer.succeed(Registry, registry),
            Layer.succeed(Workspace, new StaticWorkspace([])),
            Layer.succeed(ProcessManager, processManager),
            Layer.succeed(ReverseProxy, reverseProxy),
            Layer.succeed(ServiceRunner, new StaticServiceRunner()),
            Layer.succeed(HookRunner, new StaticHookRunner()),
            Layer.succeed(EnvLoader, new StaticEnvLoader()),
            Layer.succeed(BinInstaller, new StaticBinInstaller()),
          ),
        ),
      ),
    )

    expect(exitCode).toBe(0)
    expect(logger.successes.at(-1)?.message).toBe("Project forgotten and rig state purged.")
    expect(processManager.uninstallCalls).toEqual(["rig.pantry.dev", "rig.pantry.prod"])
    expect(reverseProxy.removeCalls).toEqual([
      { name: "pantry", env: "dev" },
      { name: "pantry", env: "prod" },
    ])
    expect(await Bun.file(shimPath).exists()).toBe(false)
    expect(await Bun.file(historyPath).exists()).toBe(false)
    expect(await Bun.file(join(rigWorkspacesRoot(), "pantry")).exists()).toBe(false)
    expect(await Effect.runPromise(registry.list())).toEqual([])

    await rm(root, { recursive: true, force: true })
  })
})
