import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runStatusCommand } from "./status.js"
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
import { NodeFileSystemLive } from "../providers/node-fs.js"
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

const writeRigConfig = async (repoPath: string, config: unknown) => {
  await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

describe("GIVEN suite context WHEN status command executes THEN behavior is covered", () => {
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
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
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
        services: 1,
        daemonLoaded: true,
        daemonRunning: true,
        pid: 40101,
      },
      {
        name: "pantry",
        env: "prod",
        services: 1,
        daemonLoaded: true,
        daemonRunning: false,
        pid: null,
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
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
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
        services: 1,
        daemonLoaded: true,
        daemonRunning: false,
        pid: null,
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
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
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
        services: 1,
        daemonLoaded: false,
        daemonRunning: false,
        pid: null,
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
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ pantry: repoPath })),
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
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({}, entries)),
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
        devRunning: true,
        prodRunning: false,
        repoPath: "/repos/pantry",
      },
      {
        name: "docs",
        devRunning: false,
        prodRunning: true,
        repoPath: "/repos/docs",
      },
    ])
  })
})
