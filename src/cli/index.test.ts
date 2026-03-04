import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
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
import { ServiceRunner } from "../interfaces/service-runner.js"
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
import type { RigError } from "../schema/errors.js"

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
    const entry: RegistryEntry = {
      name: "pantry",
      repoPath: this.repoPath,
      registeredAt: new Date(0),
    }

    return Effect.succeed([entry])
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

const makeLayer = (logger: CaptureLogger) =>
  Layer.mergeAll(
    Layer.succeed(Logger, logger),
    Layer.succeed(Registry, new StaticRegistry(repoPath)),
    Layer.succeed(Workspace, new TestWorkspace(join(workspaceRoot, randomUUID()))),
    NodeFileSystemLive,
    StubHookRunnerLive,
    Layer.succeed(Git, new StubGit()),
    Layer.succeed(ReverseProxy, new StubReverseProxy()),
    Layer.succeed(ProcessManager, new StubProcessManager()),
    Layer.succeed(ServiceRunner, new StubServiceRunner()),
    Layer.succeed(HealthChecker, new StubHealthChecker()),
    StubPortCheckerLive,
    Layer.succeed(BinInstaller, new StubBinInstaller()),
    Layer.succeed(EnvLoader, {
      load: () => Effect.succeed({}),
    }),
  )

const runWithLogger = async (argv: readonly string[]) => {
  const logger = new CaptureLogger()
  const exitCode = await Effect.runPromise(runCli(argv).pipe(Effect.provide(makeLayer(logger))))
  return { exitCode, logger }
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
    const { exitCode, logger } = await runWithLogger(["init", "pantry", "--path", repoPath])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)

    const ready = logger.infos.find((entry) => entry.message === "init command scaffold ready.")
    expect(ready).toBeDefined()
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

    const ready = logger.infos.find((entry) => entry.message === "logs command scaffold ready.")
    expect(ready).toBeDefined()
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

    const ready = logger.infos.find((entry) => entry.message === "logs command scaffold ready.")
    expect(ready).toBeDefined()
    expect(ready?.details?.follow).toBe(true)
    expect(ready?.details?.lines).toBe(25)
    expect(ready?.details?.service).toBe("web")
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

  for (const action of ["patch", "minor", "major", "undo", "list"] as const) {
    test(`GIVEN test setup WHEN with name and ${action} returns 0 THEN expected behavior is observed`, async () => {
      const { exitCode, logger } = await runWithLogger(["version", "pantry", action])

      expect(exitCode).toBe(0)
      expect(logger.errors).toHaveLength(0)

      const resolved = logger.infos.find((entry) => entry.message === "Version command resolved state.")
      expect(resolved?.details?.action).toBe(action)
    })
  }

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
