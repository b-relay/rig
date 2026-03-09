import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runLogsCommand } from "./logs.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  Registry,
  type Registry as RegistryService,
} from "../interfaces/registry.js"
import {
  Workspace,
  type Workspace as WorkspaceService,
  type WorkspaceInfo,
} from "../interfaces/workspace.js"
import {
  ServiceRunner,
  type HealthStatus,
  type LogOpts,
  type RunOpts,
  type RunningService,
  type ServiceRunner as ServiceRunnerService,
} from "../interfaces/service-runner.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import type { ServerService } from "../schema/config.js"
import { CliArgumentError, ServiceRunnerError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly infos: string[] = []

  info(message: string) {
    this.infos.push(message)
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

class TrackingServiceRunner implements ServiceRunnerService {
  readonly logsCalls: Array<{ readonly service: string; readonly opts: LogOpts }> = []

  constructor(private readonly outputByService: Readonly<Record<string, string>>) {}

  start(_service: ServerService, _opts: RunOpts): Effect.Effect<RunningService, ServiceRunnerError> {
    return Effect.fail(new ServiceRunnerError("start", "test", "not used", "not used"))
  }

  stop(_service: RunningService): Effect.Effect<void, ServiceRunnerError> {
    return Effect.void
  }

  health(_service: RunningService): Effect.Effect<HealthStatus, ServiceRunnerError> {
    return Effect.succeed("healthy")
  }

  logs(service: string, opts: LogOpts): Effect.Effect<string, ServiceRunnerError> {
    this.logsCalls.push({ service, opts })

    const output = this.outputByService[service]
    if (!output) {
      return Effect.fail(
        new ServiceRunnerError(
          "logs",
          service,
          `No logs configured for '${service}'.`,
          "Configure test fixture output.",
        ),
      )
    }

    return Effect.succeed(output)
  }
}

class StaticWorkspace implements WorkspaceService {
  constructor(private readonly workspacePath: string) {}

  create(_name: string, _env: "dev" | "prod", _version: string, _commitRef: string) {
    return Effect.succeed(this.workspacePath)
  }

  resolve(_name: string, _env: "dev" | "prod", _version?: string) {
    return Effect.succeed(this.workspacePath)
  }

  activate(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.succeed(this.workspacePath)
  }

  removeVersion(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.void
  }

  renameVersion(_name: string, _env: "dev" | "prod", _fromVersion: string, _toVersion: string) {
    return Effect.succeed(this.workspacePath)
  }

  sync(_name: string, _env: "dev" | "prod") {
    return Effect.void
  }

  list(_name: string) {
    return Effect.succeed([] as readonly WorkspaceInfo[])
  }
}

const writeRigConfig = async (repoPath: string) => {
  await writeFile(
    join(repoPath, "rig.json"),
    `${JSON.stringify(
      {
        name: "pantry",
        version: "1.0.0",
        environments: {
          dev: {
            services: [
              { name: "web", type: "server", command: "echo web", port: 5173 },
              { name: "worker", type: "bin", entrypoint: "bun run worker.ts" },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}

const createLayer = (repoPath: string, logger: CaptureLogger, serviceRunner: TrackingServiceRunner) =>
  Layer.mergeAll(
    NodeFileSystemLive,
    Layer.succeed(Logger, logger),
    Layer.succeed(Registry, new StaticRegistry(repoPath)),
    Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
    Layer.succeed(ServiceRunner, serviceRunner),
  )

describe("GIVEN suite context WHEN logs command executes THEN behavior is covered", () => {
  test("GIVEN multiple services WHEN logs runs without --service THEN it fetches and prints logs for each service", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-logs-all-"))
    await writeRigConfig(repoPath)

    const logger = new CaptureLogger()
    const serviceRunner = new TrackingServiceRunner({
      web: "web log line",
      worker: "worker log line",
    })
    const layer = createLayer(repoPath, logger, serviceRunner)

    const exitCode = await Effect.runPromise(
      runLogsCommand({ name: "pantry", env: "dev", follow: false, lines: 50 }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(exitCode).toBe(0)
    expect(serviceRunner.logsCalls).toHaveLength(2)
    expect(serviceRunner.logsCalls.map((call) => call.service)).toEqual(["web", "worker"])
    expect(logger.infos).toEqual(["web log line", "worker log line"])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN --service web WHEN logs runs THEN it only fetches logs for the selected service", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-logs-service-"))
    await writeRigConfig(repoPath)

    const logger = new CaptureLogger()
    const serviceRunner = new TrackingServiceRunner({
      web: "web selected logs",
      worker: "worker logs",
    })
    const layer = createLayer(repoPath, logger, serviceRunner)

    const exitCode = await Effect.runPromise(
      runLogsCommand({
        name: "pantry",
        env: "dev",
        follow: true,
        lines: 25,
        service: "web",
      }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(serviceRunner.logsCalls).toEqual([
      {
        service: "web",
        opts: {
          follow: true,
          lines: 25,
          service: "web",
          workspacePath: repoPath,
        },
      },
    ])
    expect(logger.infos).toEqual(["web selected logs"])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN --service api WHEN service is not defined THEN it fails with CliArgumentError", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-logs-invalid-service-"))
    await writeRigConfig(repoPath)

    const logger = new CaptureLogger()
    const serviceRunner = new TrackingServiceRunner({
      web: "web logs",
      worker: "worker logs",
    })
    const layer = createLayer(repoPath, logger, serviceRunner)

    const result = await Effect.runPromise(
      runLogsCommand({
        name: "pantry",
        env: "dev",
        follow: false,
        lines: 10,
        service: "api",
      }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(CliArgumentError)
      const error = result.left as CliArgumentError
      expect(error.command).toBe("logs")
      expect(error.message).toContain("Service 'api' is not defined")
    }

    await rm(repoPath, { recursive: true, force: true })
  })
})
