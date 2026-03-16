import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runStatusCommand } from "./status.js"
import { versionHistoryPath } from "./state-paths.js"
import { Git } from "../interfaces/git.js"
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
import {
  Workspace,
  type Workspace as WorkspaceService,
  type WorkspaceInfo,
} from "../interfaces/workspace.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { StubGit } from "../providers/stub-git.js"
import { ConfigValidationError, ProcessError, RegistryError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly tables: Array<readonly Record<string, unknown>[]> = []

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

  table(rows: readonly Record<string, unknown>[]) {
    this.tables.push(rows)
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

class StaticRegistry implements RegistryService {
  constructor(
    private readonly repoByName: Readonly<Record<string, string>>,
    private readonly entries: readonly RegistryEntry[] = [],
  ) {}

  register(_name: string, _repoPath: string) {
    return Effect.void
  }

  unregister(_name: string) {
    return Effect.void
  }

  resolve(name: string) {
    const repoPath = this.repoByName[name]
    if (!repoPath) {
      return Effect.fail(new RegistryError("resolve", name, `Project '${name}' not found`, "Register project first."))
    }

    return Effect.succeed(repoPath)
  }

  list() {
    return Effect.succeed(this.entries)
  }
}

class StaticProcessManager implements ProcessManagerService {
  readonly statusCalls: string[] = []

  constructor(
    private readonly statuses: Readonly<Record<string, DaemonStatus>> = {},
    private readonly failLabels: readonly string[] = [],
  ) {}

  install(_config: DaemonConfig) {
    return Effect.void
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
    this.statusCalls.push(label)

    if (this.failLabels.includes(label)) {
      return Effect.fail(new ProcessError("status", label, `Failed to read daemon status for ${label}`, "retry"))
    }

    return Effect.succeed(
      this.statuses[label] ?? {
        label,
        loaded: false,
        running: false,
        pid: null,
      },
    )
  }

  backup(_label: string) {
    return Effect.succeed("/tmp/backup.plist")
  }
}

class StaticWorkspace implements WorkspaceService {
  constructor(
    private readonly pathsByKey: Readonly<Record<string, string>>,
    private readonly rows: readonly WorkspaceInfo[] = [],
  ) {}

  create(name: string, env: "dev" | "prod", _version: string, _commitRef: string) {
    return Effect.succeed(this.pathsByKey[`${name}:${env}`] ?? "/tmp/workspace")
  }

  resolve(name: string, env: "dev" | "prod", version?: string) {
    if (env === "prod" && version) {
      return Effect.succeed(this.pathsByKey[`${name}:${env}:${version}`] ?? this.pathsByKey[`${name}:${env}`] ?? "/tmp/workspace")
    }

    return Effect.succeed(this.pathsByKey[`${name}:${env}`] ?? "/tmp/workspace")
  }

  activate(name: string, env: "dev" | "prod", version: string) {
    return Effect.succeed(this.pathsByKey[`${name}:${env}:${version}`] ?? this.pathsByKey[`${name}:${env}`] ?? "/tmp/workspace")
  }

  removeVersion(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.void
  }

  renameVersion(name: string, env: "dev" | "prod", _fromVersion: string, toVersion: string) {
    return Effect.succeed(this.pathsByKey[`${name}:${env}:${toVersion}`] ?? this.pathsByKey[`${name}:${env}`] ?? "/tmp/workspace")
  }

  sync(_name: string, _env: "dev" | "prod") {
    return Effect.void
  }

  list(_name: string) {
    return Effect.succeed(this.rows)
  }
}

const writeRigConfig = async (repoPath: string, config: unknown) => {
  await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

const writePidFile = async (workspacePath: string, pids: unknown) => {
  const pidsPath = join(workspacePath, ".rig", "pids.json")
  await mkdir(join(workspacePath, ".rig"), { recursive: true })
  await writeFile(pidsPath, `${JSON.stringify(pids, null, 2)}\n`, "utf8")
}

const findDefinitelyDeadPid = (): number => {
  for (const candidate of [999_999, 888_888, 777_777]) {
    try {
      process.kill(candidate, 0)
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? String((cause as { code?: unknown }).code)
          : ""
      if (code === "ESRCH") {
        return candidate
      }
    }
  }

  return 999_999
}

describe("GIVEN suite context WHEN status command executes THEN behavior is covered", () => {
  beforeEach(async () => {
    process.env.RIG_ROOT = await mkdtemp(join(tmpdir(), "rig-status-state-"))
  })

  test("GIVEN a project with both dev and prod envs WHEN status is called without env flag THEN it shows rows for both environments", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-status-both-envs-"))
    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            { name: "web-dev", type: "server", command: "echo web-dev", port: 5173 },
          ],
        },
        prod: {
          services: [
            { name: "web-prod", type: "server", command: "echo web-prod", port: 3070 },
          ],
        },
      },
    })

    const logger = new CaptureLogger()
    const processManager = new StaticProcessManager({
      "rig.pantry.dev": {
        label: "rig.pantry.dev",
        loaded: true,
        running: true,
        pid: 40101,
      },
      "rig.pantry.prod": {
        label: "rig.pantry.prod",
        loaded: true,
        running: false,
        pid: null,
      },
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
      Layer.succeed(Workspace, new StaticWorkspace({ "pantry:dev": repoPath, "pantry:prod": repoPath })),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
      runStatusCommand({ name: "pantry" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables).toHaveLength(1)
    expect(logger.tables[0]).toEqual([
      {
        name: "pantry",
        env: "dev",
        latestProdVersion: "N/A",
        currentProdVersion: "N/A",
        services: 1,
        daemonLoaded: true,
        daemonRunning: true,
        daemonPid: 40101,
        service: null,
        pid: null,
        port: null,
        alive: null,
        startedAt: null,
        uptimeSeconds: null,
      },
      {
        name: "pantry",
        env: "prod",
        latestProdVersion: "N/A",
        currentProdVersion: "N/A",
        version: "1.0.0",
        services: 1,
        daemonLoaded: true,
        daemonRunning: false,
        daemonPid: null,
        service: null,
        pid: null,
        port: null,
        alive: null,
        startedAt: null,
        uptimeSeconds: null,
      },
    ])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a project with only dev env WHEN status is called without env flag THEN it shows only the dev row", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-status-dev-only-"))
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

    const logger = new CaptureLogger()
    const processManager = new StaticProcessManager({
      "rig.pantry.dev": {
        label: "rig.pantry.dev",
        loaded: true,
        running: false,
        pid: null,
      },
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
      Layer.succeed(Workspace, new StaticWorkspace({ "pantry:dev": repoPath, "pantry:prod": repoPath })),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
      runStatusCommand({ name: "pantry" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables).toHaveLength(1)
    expect(logger.tables[0]).toEqual([
      {
        name: "pantry",
        env: "dev",
        latestProdVersion: "N/A",
        currentProdVersion: "N/A",
        services: 1,
        daemonLoaded: true,
        daemonRunning: false,
        daemonPid: null,
        service: null,
        pid: null,
        port: null,
        alive: null,
        startedAt: null,
        uptimeSeconds: null,
      },
    ])
    expect(processManager.statusCalls).toEqual(["rig.pantry.dev"])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a project with only dev env WHEN status is called with --dev THEN it shows the dev row", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-status-only-dev-flag-dev-"))
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

    const logger = new CaptureLogger()
    const processManager = new StaticProcessManager({
      "rig.pantry.dev": {
        label: "rig.pantry.dev",
        loaded: false,
        running: false,
        pid: null,
      },
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
      Layer.succeed(Workspace, new StaticWorkspace({ "pantry:dev": repoPath, "pantry:prod": repoPath })),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
      runStatusCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables).toHaveLength(1)
    expect(logger.tables[0]).toEqual([
      {
        name: "pantry",
        env: "dev",
        latestProdVersion: "N/A",
        currentProdVersion: "N/A",
        services: 1,
        daemonLoaded: false,
        daemonRunning: false,
        daemonPid: null,
        service: null,
        pid: null,
        port: null,
        alive: null,
        startedAt: null,
        uptimeSeconds: null,
      },
    ])
    expect(processManager.statusCalls).toEqual(["rig.pantry.dev"])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a project with only dev env WHEN status is called with --prod THEN it fails with ConfigValidationError", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-status-only-dev-flag-prod-"))
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

    const logger = new CaptureLogger()
    const processManager = new StaticProcessManager()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
      Layer.succeed(Workspace, new StaticWorkspace({ "pantry:dev": repoPath, "pantry:prod": repoPath })),
      Layer.succeed(ProcessManager, processManager),
    )

    const result = await Effect.runPromise(
      runStatusCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN pids.json has a live service pid WHEN status is called for that env THEN the row reports alive true with service details", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-status-live-pid-"))
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
    const startedAt = new Date("2026-03-08T10:00:00.000Z").toISOString()
    await writePidFile(repoPath, {
      web: { pid: process.pid, port: 3101, startedAt },
    })

    const logger = new CaptureLogger()
    const processManager = new StaticProcessManager({
      "rig.pantry.dev": {
        label: "rig.pantry.dev",
        loaded: false,
        running: false,
        pid: null,
      },
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
      Layer.succeed(Workspace, new StaticWorkspace({ "pantry:dev": repoPath, "pantry:prod": repoPath })),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
      runStatusCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables).toHaveLength(1)
    expect(logger.tables[0]).toHaveLength(1)
    const row = logger.tables[0][0]
    expect(row).toMatchObject({
      name: "pantry",
      env: "dev",
      latestProdVersion: "N/A",
      currentProdVersion: "N/A",
      services: 1,
      daemonLoaded: false,
      daemonRunning: false,
      daemonPid: null,
      service: "web",
      pid: process.pid,
      port: 3101,
      alive: true,
      startedAt,
    })
    expect(typeof row.uptimeSeconds).toBe("number")

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN pids.json is missing WHEN status is called for a project THEN output includes daemon status and no service rows without crashing", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-status-missing-pids-"))
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

    const logger = new CaptureLogger()
    const processManager = new StaticProcessManager({
      "rig.pantry.dev": {
        label: "rig.pantry.dev",
        loaded: true,
        running: false,
        pid: null,
      },
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
      Layer.succeed(Workspace, new StaticWorkspace({ "pantry:dev": repoPath, "pantry:prod": repoPath })),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
      runStatusCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables).toHaveLength(1)
    expect(logger.tables[0]).toEqual([
      {
        name: "pantry",
        env: "dev",
        latestProdVersion: "N/A",
        currentProdVersion: "N/A",
        services: 1,
        daemonLoaded: true,
        daemonRunning: false,
        daemonPid: null,
        service: null,
        pid: null,
        port: null,
        alive: null,
        startedAt: null,
        uptimeSeconds: null,
      },
    ])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN pids.json has a stale pid WHEN status is called for that env THEN the row reports alive false", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-status-stale-pid-"))
    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            { name: "api", type: "server", command: "echo api", port: 5174 },
          ],
        },
      },
    })

    const stalePid = findDefinitelyDeadPid()
    await writePidFile(repoPath, {
      api: { pid: stalePid, port: 3201, startedAt: new Date("2026-03-08T11:00:00.000Z").toISOString() },
    })

    const logger = new CaptureLogger()
    const processManager = new StaticProcessManager({
      "rig.pantry.dev": {
        label: "rig.pantry.dev",
        loaded: false,
        running: false,
        pid: null,
      },
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
      Layer.succeed(Workspace, new StaticWorkspace({ "pantry:dev": repoPath, "pantry:prod": repoPath })),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
      runStatusCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables).toHaveLength(1)
    expect(logger.tables[0]).toHaveLength(1)
    const row = logger.tables[0][0]
    expect(row).toMatchObject({
      latestProdVersion: "N/A",
      currentProdVersion: "N/A",
      service: "api",
      pid: stalePid,
      port: 3201,
      alive: false,
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN no project name WHEN status is called THEN it lists all registered projects with daemon status", async () => {
    const logger = new CaptureLogger()
    const entries: readonly RegistryEntry[] = [
      {
        name: "pantry",
        repoPath: "/repos/pantry",
        registeredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        name: "docs",
        repoPath: "/repos/docs",
        registeredAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]
    const processManager = new StaticProcessManager({
      "rig.pantry.dev": {
        label: "rig.pantry.dev",
        loaded: true,
        running: true,
        pid: 1001,
      },
      "rig.pantry.prod": {
        label: "rig.pantry.prod",
        loaded: true,
        running: false,
        pid: null,
      },
      "rig.docs.dev": {
        label: "rig.docs.dev",
        loaded: false,
        running: false,
        pid: null,
      },
      "rig.docs.prod": {
        label: "rig.docs.prod",
        loaded: true,
        running: true,
        pid: 2002,
      },
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({}, entries)),
      Layer.succeed(Workspace, new StaticWorkspace({})),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
      runStatusCommand({}).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables).toHaveLength(1)
    expect(logger.tables[0]).toEqual([
      {
        name: "pantry",
        latestProdVersion: "N/A",
        currentProdVersion: "N/A",
        devRunning: true,
        prodRunning: false,
        repoPath: "/repos/pantry",
      },
      {
        name: "docs",
        latestProdVersion: "N/A",
        currentProdVersion: "N/A",
        devRunning: false,
        prodRunning: true,
        repoPath: "/repos/docs",
      },
    ])
  })

  test("GIVEN prod is pinned older WHEN project status is called THEN it shows distinct latest and current prod versions", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-status-prod-release-state-"))
    process.env.RIG_ROOT = join(repoPath, ".rig-state")
    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "0.3.0",
      environments: {
        prod: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 3070 },
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
              action: "minor",
              oldVersion: "0.1.0",
              newVersion: "0.2.0",
              changedAt: "2026-03-08T00:00:00.000Z",
            },
            {
              action: "minor",
              oldVersion: "0.2.0",
              newVersion: "0.3.0",
              changedAt: "2026-03-09T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const logger = new CaptureLogger()
    const processManager = new StaticProcessManager({
      "rig.pantry.prod": {
        label: "rig.pantry.prod",
        loaded: true,
        running: true,
        pid: 1234,
      },
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
      Layer.succeed(
        Workspace,
        new StaticWorkspace(
          { "pantry:prod": repoPath, "pantry:prod:0.2.0": repoPath },
          [
            {
              name: "pantry",
              env: "prod",
              version: "0.2.0",
              path: repoPath,
              active: true,
            },
          ],
        ),
      ),
      Layer.succeed(ProcessManager, processManager),
    )

    const exitCode = await Effect.runPromise(
      runStatusCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables[0]).toEqual([
      {
        name: "pantry",
        env: "prod",
        latestProdVersion: "0.3.0",
        currentProdVersion: "0.2.0",
        version: "0.3.0",
        services: 1,
        daemonLoaded: true,
        daemonRunning: true,
        daemonPid: 1234,
        service: null,
        pid: null,
        port: null,
        alive: null,
        startedAt: null,
        uptimeSeconds: null,
      },
    ])

    await rm(repoPath, { recursive: true, force: true })
  })
})
