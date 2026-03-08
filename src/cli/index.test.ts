import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"

import { renderCommandHelp, renderMainHelp } from "./help.js"
import { runCli } from "./index.js"
import { BinInstaller } from "../interfaces/bin-installer.js"
import { EnvLoader } from "../interfaces/env-loader.js"
import { Git } from "../interfaces/git.js"
import { HealthChecker } from "../interfaces/health-checker.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { Registry, type Registry as RegistryService, type RegistryEntry } from "../interfaces/registry.js"
import { ReverseProxy } from "../interfaces/reverse-proxy.js"
import { ServiceRunner, type LogOpts } from "../interfaces/service-runner.js"
import {
  Workspace,
  type Workspace as WorkspaceService,
  type WorkspaceInfo,
} from "../interfaces/workspace.js"
import { StubBinInstaller } from "../providers/stub-bin-installer.js"
import { StubGit } from "../providers/stub-git.js"
import { StubHealthChecker } from "../providers/stub-health-checker.js"
import { StubHookRunnerLive } from "../providers/stub-hook-runner.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { StubPortCheckerLive } from "../providers/stub-port-checker.js"
import { StubProcessManager } from "../providers/stub-process-manager.js"
import { StubReverseProxy } from "../providers/stub-reverse-proxy.js"
import { StubServiceRunner } from "../providers/stub-service-runner.js"
import { CliArgumentError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly infos: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly warnings: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly errors: RigError[] = []
  readonly tables: Array<readonly Record<string, unknown>[]> = []

  info(message: string, details?: Record<string, unknown>) {
    this.infos.push({ message, details })
    return Effect.void
  }

  warn(message: string, details?: Record<string, unknown>) {
    this.warnings.push({ message, details })
    return Effect.void
  }

  success(message: string, details?: Record<string, unknown>) {
    this.successes.push({ message, details })
    return Effect.void
  }

  error(structured: RigError) {
    this.errors.push(structured)
    return Effect.void
  }

  table(rows: readonly Record<string, unknown>[]) {
    this.tables.push(rows)
    return Effect.void
  }
}

class StaticRegistry implements RegistryService {
  private readonly entries = new Map<string, RegistryEntry>()

  constructor(private readonly fallbackRepoPath: string) {
    this.entries.set("pantry", {
      name: "pantry",
      repoPath: fallbackRepoPath,
      registeredAt: new Date(0),
    })
  }

  register(name: string, repoPath: string) {
    this.entries.set(name, {
      name,
      repoPath,
      registeredAt: new Date(),
    })
    return Effect.void
  }

  unregister(_name: string) {
    return Effect.void
  }

  resolve(name: string) {
    return Effect.succeed(this.entries.get(name)?.repoPath ?? this.fallbackRepoPath)
  }

  list() {
    return Effect.succeed(
      [...this.entries.values()].sort((left, right) => left.name.localeCompare(right.name)),
    )
  }
}

class TestWorkspace implements WorkspaceService {
  private readonly current = new Map<string, string>()

  constructor(private readonly rootPath: string) {}

  create(name: string, env: "dev" | "prod", version: string, _commitRef: string) {
    const path = join(this.rootPath, name, env, version)
    this.current.set(`${name}:${env}`, path)
    return Effect.succeed(path)
  }

  resolve(name: string, env: "dev" | "prod") {
    return Effect.succeed(this.current.get(`${name}:${env}`) ?? join(this.rootPath, name, env, "current"))
  }

  sync(_name: string, _env: "dev" | "prod") {
    return Effect.void
  }

  list(name: string) {
    const rows: WorkspaceInfo[] = []

    for (const env of ["dev", "prod"] as const) {
      const path = this.current.get(`${name}:${env}`)
      if (!path) {
        continue
      }

      rows.push({
        name,
        env,
        version: path.split("/").pop() ?? null,
        path,
        active: true,
      })
    }

    return Effect.succeed(rows)
  }
}

class CliServiceRunner extends StubServiceRunner {
  override logs(service: string, opts: LogOpts) {
    return Effect.succeed(
      `${service}: cli logs (lines=${opts.lines}, follow=${opts.follow}, service=${opts.service ?? "all"})`,
    )
  }
}

const writeValidRigConfig = async (repoPath: string) => {
  await writeFile(
    join(repoPath, "rig.json"),
    `${JSON.stringify(
      {
        name: "pantry",
        version: "0.1.0",
        environments: {
          dev: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bunx vite dev --host 127.0.0.1 --port 5173",
                port: 5173,
                healthCheck: "http://127.0.0.1:5173",
              },
            ],
          },
          prod: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bunx vite preview --host 127.0.0.1 --port 3070",
                port: 3070,
                healthCheck: "http://127.0.0.1:3070",
              },
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

let tempRoot: string
let repoPath: string
let workspaceRoot: string

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "rig-cli-args-"))
  repoPath = join(tempRoot, "repo")
  workspaceRoot = join(tempRoot, "workspaces")

  await mkdir(repoPath, { recursive: true })
  await mkdir(workspaceRoot, { recursive: true })
  await writeValidRigConfig(repoPath)
})

afterAll(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

const makeLayer = (logger: CaptureLogger, registry: StaticRegistry) =>
  Layer.mergeAll(
    Layer.succeed(Logger, logger),
    Layer.succeed(Registry, registry),
    Layer.succeed(Workspace, new TestWorkspace(join(workspaceRoot, randomUUID()))),
    NodeFileSystemLive,
    StubHookRunnerLive,
    Layer.succeed(Git, new StubGit()),
    Layer.succeed(ReverseProxy, new StubReverseProxy()),
    Layer.succeed(ProcessManager, new StubProcessManager()),
    Layer.succeed(ServiceRunner, new CliServiceRunner()),
    Layer.succeed(HealthChecker, new StubHealthChecker()),
    StubPortCheckerLive,
    Layer.succeed(BinInstaller, new StubBinInstaller()),
    Layer.succeed(EnvLoader, {
      load: () => Effect.succeed({}),
    }),
  )

const runWithLogger = async (argv: readonly string[]) => {
  const logger = new CaptureLogger()
  const registry = new StaticRegistry(repoPath)
  const exitCode = await Effect.runPromise(runCli(argv).pipe(Effect.provide(makeLayer(logger, registry))))
  return { exitCode, logger, registry }
}

describe("GIVEN suite context WHEN cli global help parsing THEN behavior is covered", () => {
  test("GIVEN test setup WHEN no args shows main help and returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger([])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.infos.some((entry) => entry.message === renderMainHelp())).toBe(true)
  })

  for (const flag of ["--help", "-h"] as const) {
    test(`GIVEN test setup WHEN ${flag} shows main help and returns 0 THEN expected behavior is observed`, async () => {
      const { exitCode, logger } = await runWithLogger([flag])

      expect(exitCode).toBe(0)
      expect(logger.errors).toHaveLength(0)
      expect(logger.infos.some((entry) => entry.message === renderMainHelp())).toBe(true)
    })
  }

  test("GIVEN test setup WHEN help shows main help and returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["help"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.infos.some((entry) => entry.message === renderMainHelp())).toBe(true)
  })

  test("GIVEN test setup WHEN help deploy shows command help and returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["help", "deploy"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.infos.some((entry) => entry.message === renderCommandHelp("deploy"))).toBe(true)
  })

  test("GIVEN test setup WHEN unknown command logs error and returns 1 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["not-a-command"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)

    const first = logger.errors[0]
    expect(first?._tag).toBe("CliArgumentError")

    if (first?._tag === "CliArgumentError") {
      expect(first.command).toBe("global")
      expect(first.message).toContain("Unknown command")
      expect(first.hint).toContain("rig --help")
    }
  })

  test("GIVEN test setup WHEN --verbose is passed globally THEN it is ignored by parser and help still renders THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["--verbose", "help"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.infos.some((entry) => entry.message === renderMainHelp())).toBe(true)
  })

  test("GIVEN test setup WHEN main help is rendered THEN --verbose is documented in global patterns THEN expected behavior is observed", () => {
    const help = renderMainHelp()
    expect(help).toContain("--verbose")
    expect(help).toContain("Show detailed error information")
  })
})

describe("GIVEN suite context WHEN cli lifecycle command parsing THEN behavior is covered", () => {
  for (const command of ["deploy", "start", "stop", "restart"] as const) {
    test(`GIVEN test setup WHEN ${command}: missing project name returns 1 THEN expected behavior is observed`, async () => {
      const { exitCode, logger } = await runWithLogger([command, "--dev"])

      expect(exitCode).toBe(1)
      expect(logger.errors.length).toBeGreaterThan(0)
      expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    })

    test(`GIVEN test setup WHEN ${command}: missing env flag returns 1 with hint THEN expected behavior is observed`, async () => {
      const { exitCode, logger } = await runWithLogger([command, "pantry"])

      expect(exitCode).toBe(1)
      expect(logger.errors.length).toBeGreaterThan(0)

      const first = logger.errors[0]
      expect(first?._tag).toBe("CliArgumentError")

      if (first?._tag === "CliArgumentError") {
        expect(first.message).toBe("Missing environment flag.")
        expect(first.hint).toBe("Pass exactly one of --dev or --prod.")
      }
    })

    test(`GIVEN test setup WHEN ${command}: conflicting --dev --prod returns 1 with hint THEN expected behavior is observed`, async () => {
      const { exitCode, logger } = await runWithLogger([command, "pantry", "--dev", "--prod"])

      expect(exitCode).toBe(1)
      expect(logger.errors.length).toBeGreaterThan(0)

      const first = logger.errors[0]
      expect(first?._tag).toBe("CliArgumentError")

      if (first?._tag === "CliArgumentError") {
        expect(first.message).toBe("Conflicting environment flags.")
        expect(first.hint).toBe("Pass exactly one of --dev or --prod.")
      }
    })

    test(`GIVEN test setup WHEN ${command}: happy path with --dev returns 0 THEN expected behavior is observed`, async () => {
      const { exitCode, logger } = await runWithLogger([command, "pantry", "--dev"])

      expect(exitCode).toBe(0)
      expect(logger.errors).toHaveLength(0)
    })

    test(`GIVEN test setup WHEN ${command}: happy path with --prod returns 0 THEN expected behavior is observed`, async () => {
      const { exitCode, logger } = await runWithLogger([command, "pantry", "--prod"])

      expect(exitCode).toBe(0)
      expect(logger.errors).toHaveLength(0)
    })

    test(`GIVEN test setup WHEN ${command}: --help shows command help and returns 0 THEN expected behavior is observed`, async () => {
      const { exitCode, logger } = await runWithLogger([command, "--help"])

      expect(exitCode).toBe(0)
      expect(logger.errors).toHaveLength(0)
      expect(logger.infos.some((entry) => entry.message === renderCommandHelp(command))).toBe(true)
    })
  }
})

describe("GIVEN suite context WHEN cli init parsing THEN behavior is covered", () => {
  test("GIVEN test setup WHEN missing name returns 1 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["init", "--path", repoPath])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)
  })

  test("GIVEN test setup WHEN missing --path returns 1 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["init", "pantry"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)
  })

  test("GIVEN test setup WHEN happy path returns 0 THEN expected behavior is observed", async () => {
    const relativePath = "./tmp/rig-cli-init-relative"
    const { exitCode, logger, registry } = await runWithLogger([
      "init",
      "pantry",
      "--path",
      relativePath,
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(await Effect.runPromise(registry.resolve("pantry"))).toBe(resolve(relativePath))
  })
})

describe("GIVEN suite context WHEN cli encounters argument errors THEN command help is printed", () => {
  test("GIVEN test setup WHEN deploy is run with no args THEN error and deploy help are both logged THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["deploy"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)
    expect(logger.infos.some((entry) => entry.message.includes(renderCommandHelp("deploy")))).toBe(true)
  })

  test("GIVEN test setup WHEN start is run with no args THEN error and start help are both logged THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["start"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)
    expect(logger.infos.some((entry) => entry.message.includes(renderCommandHelp("start")))).toBe(true)
  })

  test("GIVEN test setup WHEN deploy is run with conflicting env flags THEN error and deploy help are both logged THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["deploy", "--dev", "--prod"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)
    expect(logger.infos.some((entry) => entry.message.includes(renderCommandHelp("deploy")))).toBe(true)
  })

  test("GIVEN test setup WHEN an unknown command is run THEN error and main help are both logged THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["notacommand"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)
    expect(logger.infos.some((entry) => entry.message.includes(renderMainHelp()))).toBe(true)
  })

  test("GIVEN test setup WHEN init is run with missing args THEN error and init help are both logged THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["init"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)
    expect(logger.infos.some((entry) => entry.message.includes(renderCommandHelp("init")))).toBe(true)
  })
})

describe("GIVEN suite context WHEN cli status parsing THEN behavior is covered", () => {
  test("GIVEN test setup WHEN no name and no env returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["status"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.tables.length).toBeGreaterThan(0)
  })

  test("GIVEN test setup WHEN with name returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["status", "pantry"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.tables.at(-1)?.length).toBe(2)
  })

  test("GIVEN test setup WHEN with name and --dev returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["status", "pantry", "--dev"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.tables.at(-1)?.length).toBe(1)
  })

  test("GIVEN test setup WHEN too many positionals returns 1 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["status", "pantry", "extra"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)

    const first = logger.errors[0]
    expect(first?._tag).toBe("CliArgumentError")

    if (first?._tag === "CliArgumentError") {
      expect(first.message).toBe("Too many positional arguments.")
    }
  })
})

describe("GIVEN suite context WHEN cli logs parsing THEN behavior is covered", () => {
  test("GIVEN test setup WHEN happy path with required args returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["logs", "pantry", "--dev"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)

    const webLogs = logger.infos.find((entry) => entry.message.includes("web: cli logs"))
    expect(webLogs).toBeDefined()
  })

  test("GIVEN test setup WHEN missing env returns 1 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["logs", "pantry"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)

    const first = logger.errors[0]
    expect(first?._tag).toBe("CliArgumentError")

    if (first?._tag === "CliArgumentError") {
      expect(first.hint).toBe("Pass exactly one of --dev or --prod.")
    }
  })

  test("GIVEN test setup WHEN with --follow, --lines, --service returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger([
      "logs",
      "pantry",
      "--prod",
      "--follow",
      "--lines",
      "25",
      "--service",
      "web",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)

    const webLogs = logger.infos.find((entry) => entry.message.includes("web: cli logs"))
    expect(webLogs).toBeDefined()
    expect(webLogs?.message).toContain("follow=true")
    expect(webLogs?.message).toContain("lines=25")
    expect(webLogs?.message).toContain("service=web")
  })

  test("GIVEN test setup WHEN --verbose is included in logs args THEN command parser ignores it and executes successfully THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["logs", "pantry", "--dev", "--verbose"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
  })
})

describe("GIVEN suite context WHEN cli version parsing THEN behavior is covered", () => {
  test("GIVEN test setup WHEN with name only defaults to show and returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["version", "pantry"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)

    const resolved = logger.infos.find((entry) => entry.message === "Version command resolved state.")
    expect(resolved?.details?.action).toBe("show")
  })

  for (const action of ["patch", "minor", "major", "list"] as const) {
    test(`GIVEN test setup WHEN with name and ${action} returns 0 THEN expected behavior is observed`, async () => {
      const { exitCode, logger } = await runWithLogger(["version", "pantry", action])

      expect(exitCode).toBe(0)
      expect(logger.errors).toHaveLength(0)
    })
  }

  test("GIVEN test setup WHEN with name and undo THEN it returns 0 and logs success", async () => {
    const { exitCode, logger } = await runWithLogger(["version", "pantry", "undo"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.successes.some((entry) => entry.message === "Version bump undone.")).toBe(true)
  })

  test("GIVEN test setup WHEN too many positionals returns 1 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["version", "pantry", "patch", "extra"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)

    const first = logger.errors[0]
    expect(first?._tag).toBe("CliArgumentError")

    if (first?._tag === "CliArgumentError") {
      expect(first.hint).toContain("rig version")
    }
  })
})

describe("GIVEN suite context WHEN cli list/config parsing THEN behavior is covered", () => {
  test("GIVEN test setup WHEN list with no args returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["list"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.tables.length).toBeGreaterThan(0)
  })

  test("GIVEN test setup WHEN list with unexpected positionals returns 1 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["list", "extra"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)

    const first = logger.errors[0]
    expect(first?._tag).toBe("CliArgumentError")

    if (first?._tag === "CliArgumentError") {
      expect(first.message).toBe("Unexpected positional arguments.")
    }
  })

  test("GIVEN test setup WHEN config with no args returns 0 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["config"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.infos.some((entry) => entry.message === "rig.json schema reference")).toBe(true)
  })

  test("GIVEN test setup WHEN config with unexpected positionals returns 1 THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["config", "extra"])

    expect(exitCode).toBe(1)
    expect(logger.errors.length).toBeGreaterThan(0)

    const first = logger.errors[0]
    expect(first?._tag).toBe("CliArgumentError")

    if (first?._tag === "CliArgumentError") {
      expect(first.message).toBe("Unexpected positional arguments.")
    }
  })
})

describe("GIVEN suite context WHEN cli start foreground THEN behavior is covered", () => {
  test("GIVEN test setup WHEN accepts --foreground and forwards it to runtime handler THEN expected behavior is observed", async () => {
    const { exitCode, logger } = await runWithLogger(["start", "pantry", "--dev", "--foreground"])

    expect(exitCode).toBe(0)

    const started = logger.successes.find((entry) => entry.message === "Services started.")
    expect(started).toBeDefined()
    expect(started?.details?.foreground).toBe(true)
  })

  test("GIVEN test setup WHEN start help text documents --foreground THEN expected behavior is observed", () => {
    const help = renderCommandHelp("start")
    expect(help).toContain("--foreground")
  })
})

describe("GIVEN suite context WHEN main catches unexpected cli errors THEN behavior is covered", () => {
  test("GIVEN test setup WHEN runCli fails with RigError THEN main logs structured error through Logger and returns 1 THEN expected behavior is observed", async () => {
    const originalRunCli = runCli
    const originalTerminalLoggerModule = await import("../providers/terminal-logger.js")
    const originalLogFormat = process.env.RIG_LOG_FORMAT
    const originalLogFile = process.env.RIG_LOG_FILE
    const captureLogger = new CaptureLogger()

    mock.module("./index.js", () => ({
      runCli: () =>
        Effect.fail(
          new CliArgumentError(
            "status",
            "Test RigError for main catchAll path.",
            "Use `rig status --help` to inspect command usage.",
          ),
        ),
    }))
    mock.module("../providers/terminal-logger.js", () => ({
      ...originalTerminalLoggerModule,
      TerminalLoggerLive: Layer.succeed(Logger, captureLogger),
    }))
    delete process.env.RIG_LOG_FORMAT
    delete process.env.RIG_LOG_FILE

    try {
      const { main } = await import(`../index.js?rig-error-${randomUUID()}`)
      const exitCode = await main(["status"])

      expect(exitCode).toBe(1)
      expect(captureLogger.errors).toHaveLength(1)
      expect(captureLogger.warnings).toHaveLength(0)

      const first = captureLogger.errors[0]
      expect(first?._tag).toBe("CliArgumentError")
      if (first?._tag === "CliArgumentError") {
        expect(first.command).toBe("status")
        expect(first.message).toBe("Test RigError for main catchAll path.")
        expect(first.hint).toContain("rig status --help")
      }
    } finally {
      mock.module("./index.js", () => ({ runCli: originalRunCli }))
      mock.module("../providers/terminal-logger.js", () => originalTerminalLoggerModule)

      if (originalLogFormat === undefined) {
        delete process.env.RIG_LOG_FORMAT
      } else {
        process.env.RIG_LOG_FORMAT = originalLogFormat
      }

      if (originalLogFile === undefined) {
        delete process.env.RIG_LOG_FILE
      } else {
        process.env.RIG_LOG_FILE = originalLogFile
      }
    }
  })

  test("GIVEN test setup WHEN runCli fails with non-Rig error THEN main returns 1 THEN expected behavior is observed", async () => {
    const originalRunCli = runCli

    mock.module("./index.js", () => ({
      runCli: () => Effect.fail(new Error("Unexpected CLI failure while parsing command arguments.")),
    }))

    try {
      const { main } = await import(`../index.js?unexpected-error-${randomUUID()}`)
      const exitCode = await main(["status"])
      expect(exitCode).toBe(1)
    } finally {
      mock.module("./index.js", () => ({ runCli: originalRunCli }))
    }
  })
})
