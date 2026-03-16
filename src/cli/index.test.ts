import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"

import { renderCommandHelp, renderMainHelp } from "./help.js"
import { runCli } from "./index.js"
import { versionHistoryPath } from "../core/state-paths.js"
import { BinInstaller } from "../interfaces/bin-installer.js"
import { EnvLoader } from "../interfaces/env-loader.js"
import { Git, type Git as GitService } from "../interfaces/git.js"
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
  private readonly versions = new Map<string, string>()

  constructor(private readonly rootPath: string) {}

  private versionKey(name: string, env: "dev" | "prod", version: string) {
    return `${name}:${env}:${version}`
  }

  private envKey(name: string, env: "dev" | "prod") {
    return `${name}:${env}`
  }

  private workspacePath(name: string, env: "dev" | "prod", version: string) {
    return join(this.rootPath, name, env, version)
  }

  private ensureWorkspace(path: string) {
    mkdirSync(path, { recursive: true })

    const sourceConfig = join(repoPath, "rig.json")
    const targetConfig = join(path, "rig.json")
    if (existsSync(sourceConfig)) {
      copyFileSync(sourceConfig, targetConfig)
    }
  }

  create(name: string, env: "dev" | "prod", version: string, _commitRef: string) {
    return Effect.sync(() => {
      const path = this.workspacePath(name, env, version)
      this.ensureWorkspace(path)
      this.versions.set(this.versionKey(name, env, version), path)
      if (env === "dev") {
        this.current.set(this.envKey(name, env), path)
      }
      return path
    })
  }

  resolve(name: string, env: "dev" | "prod", version?: string) {
    return Effect.sync(() => {
      if (version) {
        const path =
          this.versions.get(this.versionKey(name, env, version)) ?? this.workspacePath(name, env, version)
        this.ensureWorkspace(path)
        this.versions.set(this.versionKey(name, env, version), path)
        return path
      }

      const key = this.envKey(name, env)
      const path = this.current.get(key) ?? join(this.rootPath, name, env, "current")
      this.ensureWorkspace(path)
      this.current.set(key, path)
      return path
    })
  }

  activate(name: string, env: "dev" | "prod", version: string) {
    return Effect.sync(() => {
      const path =
        this.versions.get(this.versionKey(name, env, version)) ?? this.workspacePath(name, env, version)
      this.ensureWorkspace(path)
      this.versions.set(this.versionKey(name, env, version), path)
      this.current.set(this.envKey(name, env), path)
      return path
    })
  }

  removeVersion(name: string, env: "dev" | "prod", version: string) {
    return Effect.sync(() => {
      this.versions.delete(this.versionKey(name, env, version))
      const key = this.envKey(name, env)
      if (this.current.get(key) === this.workspacePath(name, env, version)) {
        this.current.delete(key)
      }
    })
  }

  renameVersion(name: string, env: "dev" | "prod", fromVersion: string, toVersion: string) {
    return Effect.sync(() => {
      const fromKey = this.versionKey(name, env, fromVersion)
      const nextPath = this.workspacePath(name, env, toVersion)
      this.versions.delete(fromKey)
      this.ensureWorkspace(nextPath)
      this.versions.set(this.versionKey(name, env, toVersion), nextPath)
      const key = this.envKey(name, env)
      if (this.current.get(key) === this.workspacePath(name, env, fromVersion)) {
        this.current.set(key, nextPath)
      }
      return nextPath
    })
  }

  sync(_name: string, _env: "dev" | "prod") {
    return Effect.void
  }

  list(name: string) {
    const rows: WorkspaceInfo[] = [...this.versions.entries()]
      .filter(([key]) => key.startsWith(`${name}:`))
      .map(([key, path]) => {
        const [, env, version] = key.split(":")
        return {
          name,
          env: env as "dev" | "prod",
          version,
          path,
          active: this.current.get(this.envKey(name, env as "dev" | "prod")) === path,
        }
      })

    for (const env of ["dev", "prod"] as const) {
      const path = this.current.get(this.envKey(name, env))
      if (!path || rows.some((row) => row.path === path)) {
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

class FixedCommitGit extends StubGit implements GitService {
  override commitHash(_repoPath: string, _ref?: string) {
    return Effect.succeed("commit-1")
  }

  isAncestor(_repoPath: string, _ancestorRef: string, _descendantRef: string) {
    return Effect.succeed(true)
  }
}

const rigConfig = (name = "pantry", version = "0.1.0") => ({
  name,
  version,
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
      deployBranch: "main",
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
})

const writeRigConfig = async (targetPath: string, name = "pantry", version = "0.1.0") => {
  await writeFile(join(targetPath, "rig.json"), `${JSON.stringify(rigConfig(name, version), null, 2)}\n`, "utf8")
}

const writeVersionHistoryFile = async (
  name: string,
  entries: ReadonlyArray<{
    readonly action: "patch" | "minor" | "major"
    readonly oldVersion: string
    readonly newVersion: string
    readonly changedAt: string
  }>,
) => {
  process.env.RIG_ROOT = join(repoPath, ".rig-state")
  await mkdir(dirname(versionHistoryPath(name)), { recursive: true })
  await writeFile(
    versionHistoryPath(name),
    `${JSON.stringify({ name, entries }, null, 2)}\n`,
    "utf8",
  )
}

let tempRoot: string
let repoPath: string
let workspaceRoot: string
const PREVIOUS_RIG_ROOT = process.env.RIG_ROOT

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "rig-cli-args-"))
  repoPath = join(tempRoot, "repo")
  workspaceRoot = join(tempRoot, "workspaces")

  await mkdir(repoPath, { recursive: true })
  await mkdir(workspaceRoot, { recursive: true })
})

beforeEach(async () => {
  await rm(join(repoPath, ".rig"), { recursive: true, force: true })
  await writeRigConfig(repoPath)
})

afterAll(async () => {
  if (PREVIOUS_RIG_ROOT === undefined) {
    delete process.env.RIG_ROOT
  } else {
    process.env.RIG_ROOT = PREVIOUS_RIG_ROOT
  }
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

const makeLayer = (
  logger: CaptureLogger,
  registry: StaticRegistry,
  options?: {
    readonly workspace?: TestWorkspace
    readonly git?: GitService
  },
) =>
  Layer.mergeAll(
    Layer.succeed(Logger, logger),
    Layer.succeed(Registry, registry),
    Layer.succeed(Workspace, options?.workspace ?? new TestWorkspace(join(workspaceRoot, randomUUID()))),
    NodeFileSystemLive,
    StubHookRunnerLive,
    Layer.succeed(Git, options?.git ?? new FixedCommitGit()),
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

const runWithLogger = async (
  argv: readonly string[],
  options?: {
    readonly workspace?: TestWorkspace
    readonly git?: GitService
  },
) => {
  const logger = new CaptureLogger()
  const registry = new StaticRegistry(repoPath)
  const exitCode = await Effect.runPromise(
    (runCli(argv).pipe(Effect.provide(makeLayer(logger, registry, options) as never)) as Effect.Effect<
      number,
      unknown,
      never
    >),
  )
  return { exitCode, logger, registry }
}

const runWithLoggerInCwd = async (cwd: string, argv: readonly string[]) => {
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    return await runWithLogger(argv)
  } finally {
    process.chdir(previous)
  }
}

const createTestWorkspace = () => new TestWorkspace(join(workspaceRoot, randomUUID()))

const prepareProdWorkspace = async (version = "0.1.0") => {
  const workspace = createTestWorkspace()
  await Effect.runPromise(workspace.create("pantry", "prod", version, `v${version}`))
  await Effect.runPromise(workspace.activate("pantry", "prod", version))
  return workspace
}

describe("global help", () => {
  test("shows main help with no args", async () => {
    const { exitCode, logger } = await runWithLogger([])

    expect(exitCode).toBe(0)
    expect(logger.infos.some((entry) => entry.message === renderMainHelp())).toBe(true)
  })

  test("shows command help via help subcommand", async () => {
    const { exitCode, logger } = await runWithLogger(["help", "deploy"])

    expect(exitCode).toBe(0)
    expect(logger.infos.some((entry) => entry.message === renderCommandHelp("deploy"))).toBe(true)
  })

  test("shows main help for unknown commands", async () => {
    const { exitCode, logger } = await runWithLogger(["not-a-command"])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    expect(logger.infos.some((entry) => entry.message.includes(renderMainHelp()))).toBe(true)
  })

  test("documents the positional env model and prod release flags", () => {
    const mainHelp = renderMainHelp()
    const deployHelp = renderCommandHelp("deploy")
    const versionHelp = renderCommandHelp("version")

    expect(mainHelp).toContain("<dev|prod>")
    expect(mainHelp).toContain("rig deploy pantry prod --bump minor")
    expect(deployHelp).toContain("rig deploy [name] <dev|prod>")
    expect(deployHelp).toContain("--revert <semver>")
    expect(versionHelp).toContain("rig version [name] [<semver>]")
  })
})

describe("lifecycle positional env parsing", () => {
  test("deploy accepts explicit positional env", async () => {
    const { exitCode, logger } = await runWithLogger(["deploy", "pantry", "dev"])

    expect(exitCode).toBe(0)
    expect(logger.successes.some((entry) => entry.message === "Deploy applied.")).toBe(true)
  })

  test("start accepts positional env and foreground flag", async () => {
    const { exitCode, logger } = await runWithLogger(["start", "pantry", "dev", "--foreground"])

    expect(exitCode).toBe(0)
    expect(logger.successes.some((entry) => entry.message === "Services started.")).toBe(true)
    expect(logger.successes.find((entry) => entry.message === "Services started.")?.details?.foreground).toBe(true)
  })

  test("stop accepts positional env", async () => {
    const { exitCode, logger } = await runWithLogger(["stop", "pantry", "prod"])

    expect(exitCode).toBe(0)
    expect(logger.successes.some((entry) => entry.message === "Services stopped.")).toBe(true)
  })

  test("restart accepts positional env", async () => {
    const { exitCode, logger } = await runWithLogger(["restart", "pantry", "prod"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
  })

  test("logs accepts positional env and log flags", async () => {
    const { exitCode, logger } = await runWithLogger([
      "logs",
      "pantry",
      "dev",
      "--lines",
      "25",
      "--service",
      "web",
    ])

    expect(exitCode).toBe(0)
    expect(logger.infos.some((entry) => entry.message.includes("web: cli logs"))).toBe(true)
    expect(logger.infos.some((entry) => entry.message.includes("follow=false"))).toBe(true)
    expect(logger.infos.some((entry) => entry.message.includes("lines=25"))).toBe(true)
  })

  test("status accepts positional env", async () => {
    const { exitCode, logger } = await runWithLogger(["status", "pantry", "prod"])

    expect(exitCode).toBe(0)
    expect(logger.tables.at(-1)?.length).toBe(1)
  })

  test("shows command help for env-scoped commands", async () => {
    for (const command of ["deploy", "start", "stop", "restart", "status", "logs"] as const) {
      const { exitCode, logger } = await runWithLogger([command, "--help"])
      expect(exitCode).toBe(0)
      expect(logger.infos.some((entry) => entry.message === renderCommandHelp(command))).toBe(true)
    }
  })

  test("rejects missing env arguments", async () => {
    const { exitCode, logger } = await runWithLogger(["deploy", "pantry"])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    if (logger.errors[0]?._tag === "CliArgumentError") {
      expect(logger.errors[0].message).toBe("Missing environment argument.")
      expect(logger.errors[0].hint).toBe(
        "Usage: rig deploy [name] <dev|prod> [--version <semver>] [--bump <patch|minor|major>] [--revert <semver>]",
      )
    }
  })

  test("rejects obsolete env flags", async () => {
    const { exitCode, logger } = await runWithLogger(["deploy", "pantry", "--prod"])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    if (logger.errors[0]?._tag === "CliArgumentError") {
      expect(logger.errors[0].message).toBe("Invalid command arguments.")
    }
  })
})

describe("prod version targeting and release flags", () => {
  test("accepts prod --version for deploy", async () => {
    const { exitCode, logger } = await runWithLogger(["deploy", "pantry", "prod", "--version", "0.1.0"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
  })

  test("accepts prod --version for start, stop, status, and logs", async () => {
    const workspace = await prepareProdWorkspace()

    for (const argv of [
      ["start", "pantry", "prod", "--version", "0.1.0"],
      ["stop", "pantry", "prod", "--version", "0.1.0"],
      ["status", "pantry", "prod", "--version", "0.1.0"],
      ["logs", "pantry", "prod", "--version", "0.1.0"],
    ] as const) {
      const { exitCode, logger } = await runWithLogger(argv, { workspace })
      expect(exitCode).toBe(0)
      expect(logger.errors).toHaveLength(0)
    }
  })

  test("rejects --version on dev", async () => {
    const { exitCode, logger } = await runWithLogger(["logs", "pantry", "dev", "--version", "0.1.0"])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    if (logger.errors[0]?._tag === "CliArgumentError") {
      expect(logger.errors[0].message).toBe("The --version flag is only supported with prod.")
    }
  })

  test("requires a project name when status uses --version", async () => {
    const { exitCode, logger } = await runWithLogger(["status", "prod", "--version", "0.1.0"])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    if (logger.errors[0]?._tag === "CliArgumentError") {
      expect(logger.errors[0].message).toBe("A project name is required when using --version.")
      expect(logger.errors[0].hint).toBe("Usage: rig status <name> prod --version <semver>")
    }
  })

  test("accepts --bump on prod deploy", async () => {
    const { exitCode, logger } = await runWithLogger(["deploy", "pantry", "prod", "--bump", "minor"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(logger.successes.some((entry) => entry.message === "Deploy applied.")).toBe(true)
  })

  test("accepts --revert on prod deploy for the latest release", async () => {
    await writeRigConfig(repoPath, "pantry", "0.2.0")
    await writeVersionHistoryFile("pantry", [
      {
        action: "patch",
        oldVersion: "0.1.0",
        newVersion: "0.1.1",
        changedAt: new Date(0).toISOString(),
      },
      {
        action: "minor",
        oldVersion: "0.1.1",
        newVersion: "0.2.0",
        changedAt: new Date(1).toISOString(),
      },
    ])
    const workspace = await prepareProdWorkspace("0.2.0")

    const { exitCode, logger } = await runWithLogger(
      ["deploy", "pantry", "prod", "--revert", "0.2.0"],
      { workspace, git: new FixedCommitGit() },
    )

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
  })

  test("rejects --bump on dev deploy", async () => {
    const { exitCode, logger } = await runWithLogger(["deploy", "pantry", "dev", "--bump", "minor"])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    if (logger.errors[0]?._tag === "CliArgumentError") {
      expect(logger.errors[0].message).toBe("Invalid arguments.")
    }
  })

  test("rejects --revert with --version", async () => {
    const { exitCode, logger } = await runWithLogger([
      "deploy",
      "pantry",
      "prod",
      "--revert",
      "0.2.0",
      "--version",
      "0.1.1",
    ])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    if (logger.errors[0]?._tag === "CliArgumentError") {
      expect(logger.errors[0].message).toBe("Invalid arguments.")
    }
  })
})

describe("cwd autodetect", () => {
  test("supports deploy dev from the project root", async () => {
    const cwd = await mkdtemp(join(tempRoot, "rig-cli-cwd-deploy-"))
    await writeRigConfig(cwd, "testapp")

    const { exitCode, logger } = await runWithLoggerInCwd(cwd, ["deploy", "dev"])

    expect(exitCode).toBe(0)
    expect(logger.successes.find((entry) => entry.message === "Deploy applied.")?.details?.name).toBe("testapp")
  })

  test("supports stop prod from the project root", async () => {
    const cwd = await mkdtemp(join(tempRoot, "rig-cli-cwd-stop-"))
    await writeRigConfig(cwd, "testapp")

    const { exitCode, logger } = await runWithLoggerInCwd(cwd, ["stop", "prod"])

    expect(exitCode).toBe(0)
    expect(logger.successes.find((entry) => entry.message === "Services stopped.")?.details?.name).toBe("testapp")
  })

  test("errors when cwd autodetect has no rig.json", async () => {
    const cwd = await mkdtemp(join(tempRoot, "rig-cli-cwd-missing-"))
    const { exitCode, logger } = await runWithLoggerInCwd(cwd, ["deploy", "dev"])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    if (logger.errors[0]?._tag === "CliArgumentError") {
      expect(logger.errors[0].message).toContain("No rig.json found in current directory.")
    }
  })
})

describe("version command", () => {
  test("defaults to release history", async () => {
    await writeVersionHistoryFile("pantry", [
      {
        action: "minor",
        oldVersion: "0.1.0",
        newVersion: "0.2.0",
        changedAt: new Date(0).toISOString(),
      },
    ])

    const { exitCode, logger } = await runWithLogger(["version", "pantry"])

    expect(exitCode).toBe(0)
    expect(logger.tables.at(-1)?.[0]).toMatchObject({
      version: "0.2.0",
    })
  })

  test("rejects old list and mutation actions", async () => {
    let result = await runWithLogger(["version", "pantry", "list"])
    expect(result.exitCode).toBe(1)
    expect(result.logger.errors[0]?._tag).toBe("CliArgumentError")
    if (result.logger.errors[0]?._tag === "CliArgumentError") {
      expect(result.logger.errors[0].hint).toBe("Usage: rig version [name] [<semver>] [--edit <semver|patch|minor|major>]")
    }

    const { exitCode, logger } = await runWithLogger(["version", "pantry", "patch"])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    if (logger.errors[0]?._tag === "CliArgumentError") {
      expect(logger.errors[0].message).toBe("Invalid arguments.")
      expect(logger.errors[0].hint).toBe("Usage: rig version [name] [<semver>] [--edit <semver|patch|minor|major>]")
    }
  })
})

describe("other command parsing", () => {
  test("forget requires an explicit project name and supports purge", async () => {
    let result = await runWithLogger(["forget", "pantry"])
    expect(result.exitCode).toBe(0)
    expect(result.logger.errors).toHaveLength(0)

    result = await runWithLogger(["forget", "pantry", "--purge"])
    expect(result.exitCode).toBe(0)
    expect(result.logger.errors).toHaveLength(0)

    result = await runWithLogger(["forget"])
    expect(result.exitCode).toBe(1)
    expect(result.logger.errors[0]?._tag).toBe("CliArgumentError")
    if (result.logger.errors[0]?._tag === "CliArgumentError") {
      expect(result.logger.errors[0].hint).toBe("Usage: rig forget <name> [--purge]")
    }
  })

  test("init still parses and resolves paths", async () => {
    const relativePath = "./tmp/rig-cli-init-relative"
    const { exitCode, logger, registry } = await runWithLogger(["init", "pantry", "--path", relativePath])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
    expect(await Effect.runPromise(registry.resolve("pantry"))).toBe(resolve(relativePath))
  })

  test("list still rejects unexpected positionals", async () => {
    const { exitCode, logger } = await runWithLogger(["list", "extra"])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("CliArgumentError")
    if (logger.errors[0]?._tag === "CliArgumentError") {
      expect(logger.errors[0].message).toBe("Unexpected positional arguments.")
    }
  })

  test("config still autodetects from cwd", async () => {
    const cwd = await mkdtemp(join(tempRoot, "rig-cli-config-cwd-"))
    await writeRigConfig(cwd, "testapp")

    const { exitCode, logger } = await runWithLoggerInCwd(cwd, ["config"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
  })

  test("docs shows the table of contents without a project", async () => {
    const { exitCode, logger } = await runWithLogger(["docs"])

    expect(exitCode).toBe(0)
    expect(logger.infos.at(-1)?.message).toContain("Docs")
    expect(logger.infos.at(-1)?.message).toContain("config")
    expect(logger.infos.at(-1)?.message).toContain("onboard")
  })

  test("docs config accepts a specific key", async () => {
    const { exitCode, logger } = await runWithLogger(["docs", "config", "version"])

    expect(exitCode).toBe(0)
    expect(logger.infos.at(-1)?.message).toContain("version")
    expect(logger.infos.at(-1)?.message).toContain("Type: semver string")
  })

  test("docs onboard accepts a topic", async () => {
    const { exitCode, logger } = await runWithLogger(["docs", "onboard", "convex"])

    expect(exitCode).toBe(0)
    expect(logger.infos.at(-1)?.message).toContain("Convex")
    expect(logger.infos.at(-1)?.message).toContain("Agent Guidance:")
  })

  test("config unset accepts cwd autodetect", async () => {
    const cwd = await mkdtemp(join(tempRoot, "rig-cli-config-unset-cwd-"))
    await writeRigConfig(cwd, "testapp")

    const { exitCode, logger } = await runWithLoggerInCwd(cwd, ["config", "unset", "environments.prod.deployBranch"])

    expect(exitCode).toBe(0)
    expect(logger.errors).toHaveLength(0)
  })
})

describe("main catch-all behavior", () => {
  test("logs structured RigError failures through Logger", async () => {
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
      expect(captureLogger.errors[0]?._tag).toBe("CliArgumentError")
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

  test("returns 1 for unexpected non-Rig errors", async () => {
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
