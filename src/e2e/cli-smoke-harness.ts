import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { renderCommandHelp, renderMainHelp, type CommandName } from "../cli/help.js"
import type { RigConfig } from "../schema/config.js"

export interface SmokeCommandResult {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutRecords: readonly SmokeJsonRecord[]
  readonly stderrRecords: readonly SmokeJsonRecord[]
}

export interface SmokeJsonRecord {
  readonly timestamp?: string
  readonly level?: string
  readonly message?: string
  readonly details?: Record<string, unknown>
  readonly error?: {
    readonly _tag?: string
    readonly message?: string
    readonly hint?: string
    readonly [key: string]: unknown
  }
  readonly rows?: readonly Record<string, unknown>[]
}

interface SmokeProjectOptions {
  readonly name?: string
  readonly multiService?: boolean
  readonly includeBinService?: boolean
  readonly version?: string
}

interface PortPair {
  readonly web: number
  readonly worker?: number
}

export interface SmokeProject {
  readonly tempRoot: string
  readonly homeDir: string
  readonly repoPath: string
  readonly name: string
  readonly ports: PortPair
  readonly cleanup: () => Promise<void>
  readonly commitAll: (message: string) => Promise<void>
}

export interface SmokeFixtureFile {
  readonly path: string
  readonly content: string
  readonly executable?: boolean
}

export interface SmokeFixtureSpec {
  readonly name?: string
  readonly rigConfig: RigConfig
  readonly files: readonly SmokeFixtureFile[]
}

const SMOKE_BINARY_PATH = join(process.cwd(), "rig-smoke")

let ensureBuiltPromise: Promise<void> | null = null

const mergeEnv = (overrides: Record<string, string | undefined>): Record<string, string> => {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }

  return env
}

const runProcess = async (
  cmd: readonly string[],
  opts: {
    readonly cwd: string
    readonly env?: Record<string, string | undefined>
    readonly waitForMs?: number
    readonly signal?: NodeJS.Signals
  },
) => {
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd: opts.cwd,
    env: mergeEnv(opts.env ?? {}),
    stdout: "pipe",
    stderr: "pipe",
  })

  if (opts.waitForMs) {
    await new Promise((resolve) => setTimeout(resolve, opts.waitForMs))
    child.kill(opts.signal ?? "SIGTERM")
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
    child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ])

  return { stdout, stderr, exitCode }
}

const parseJsonLines = (raw: string): readonly SmokeJsonRecord[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SmokeJsonRecord]
      } catch {
        return []
      }
    })

const allocatePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate test port."))
        return
      }

      const port = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(port)
      })
    })
  })

const writeExecutable = async (path: string, content: string) => {
  await writeFile(path, content, "utf8")
  await chmod(path, 0o755)
}

const writeFixtureFile = async (root: string, file: SmokeFixtureFile) => {
  const targetPath = join(root, file.path)
  await mkdir(dirname(targetPath), { recursive: true })
  if (file.executable) {
    await writeExecutable(targetPath, file.content)
    return
  }

  await writeFile(targetPath, file.content, "utf8")
}

const git = async (repoPath: string, args: readonly string[]) => {
  const result = await runProcess(["git", ...args], { cwd: repoPath })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  }
}

const walkForFiles = async (root: string, filename: string): Promise<readonly string[]> => {
  const found: string[] = []

  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }

      if (entry.isFile() && entry.name === filename) {
        found.push(fullPath)
      }
    }
  }

  try {
    await visit(root)
  } catch {
    return found
  }

  return found
}

const killTrackedProcesses = async (roots: readonly string[]) => {
  const pidFiles = (
    await Promise.all(roots.map((root) => walkForFiles(root, "pids.json")))
  ).flat()

  const pids = new Set<number>()

  for (const file of pidFiles) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, { readonly pid?: unknown }>
      for (const entry of Object.values(parsed)) {
        if (typeof entry?.pid === "number" && Number.isInteger(entry.pid) && entry.pid > 0) {
          pids.add(entry.pid)
        }
      }
    } catch {
      continue
    }
  }

  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}

    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

const makeRigConfig = (
  name: string,
  ports: PortPair,
  opts: SmokeProjectOptions,
) => {
  const webCommand = `SERVICE_NAME=web PORT=${ports.web} bun run server.ts`
  const workerCommand =
    ports.worker !== undefined
      ? `SERVICE_NAME=worker PORT=${ports.worker} bun run server.ts`
      : null

  const services = [
    {
      name: "web",
      type: "server",
      command: webCommand,
      port: ports.web,
      healthCheck: `http://127.0.0.1:${ports.web}/health`,
      readyTimeout: 10,
    },
    ...(workerCommand
      ? [
          {
            name: "worker",
            type: "server",
            command: workerCommand,
            port: ports.worker,
            healthCheck: `http://127.0.0.1:${ports.worker}/health`,
            readyTimeout: 10,
          },
        ]
      : []),
    ...(opts.includeBinService
      ? [
          {
            name: "tool",
            type: "bin",
            entrypoint: "tool.sh",
          },
        ]
      : []),
  ]

  return {
    name,
    description: "Smoke CLI fixture project",
    version: opts.version ?? "0.1.0",
    domain: `${name}.example.test`,
    hooks: {
      preStart: "echo project-prestart >> .rig-hooks.log",
      postStop: "echo project-poststop >> .rig-hooks.log",
    },
    environments: {
      dev: {
        envFile: ".env.dev",
        services,
      },
      prod: {
        deployBranch: "main",
        envFile: ".env.prod",
        services,
      },
    },
  }
}

export const ensureSmokeBinaryBuilt = async (): Promise<void> => {
  if (!ensureBuiltPromise) {
    ensureBuiltPromise = (async () => {
      const result = await runProcess(
        [process.execPath, "build", "--compile", "src/index-smoke.ts", "--outfile", "rig-smoke"],
        { cwd: process.cwd() },
      )

      if (result.exitCode !== 0) {
        throw new Error(`Failed to build rig-smoke: ${result.stderr || result.stdout}`)
      }
    })()
  }

  return ensureBuiltPromise
}

export const createSmokeProject = async (
  opts: SmokeProjectOptions = {},
): Promise<SmokeProject> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "rig-smoke-"))
  const homeDir = join(tempRoot, "home")
  const repoPath = join(tempRoot, "repo")
  const name = opts.name ?? "pantry"
  const web = await allocatePort()
  const worker = opts.multiService ? await allocatePort() : undefined

  await mkdir(homeDir, { recursive: true })
  await mkdir(repoPath, { recursive: true })

  await writeFile(
    join(repoPath, "server.ts"),
    [
      "const port = Number(process.env.PORT ?? '0')",
      "const name = process.env.SERVICE_NAME ?? 'service'",
      "console.log(`${name} starting`)",
      "console.error(`${name} stderr`)",
      "const server = Bun.serve({",
      "  port,",
      "  fetch(req) {",
      "    const url = new URL(req.url)",
      "    if (url.pathname === '/health') return new Response('ok')",
      "    return new Response(`${name}:${port}`)",
      "  },",
      "})",
      "console.log(`${name} listening ${port}`)",
      "const timer = setInterval(() => console.log(`${name} tick`), 200)",
      "const shutdown = () => {",
      "  clearInterval(timer)",
      "  console.log(`${name} stopping`)",
      "  server.stop(true)",
      "  process.exit(0)",
      "}",
      "process.on('SIGTERM', shutdown)",
      "process.on('SIGINT', shutdown)",
      "await new Promise(() => {})",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeExecutable(
    join(repoPath, "tool.sh"),
    "#!/bin/sh\necho tool-ran \"$@\"\n",
  )
  await writeFile(join(repoPath, ".env.dev"), "DEV_ONLY=1\n", "utf8")
  await writeFile(join(repoPath, ".env.prod"), "PROD_ONLY=1\n", "utf8")
  await writeFile(join(repoPath, "README.md"), "# Smoke Fixture\n", "utf8")
  await writeFile(
    join(repoPath, "rig.json"),
    `${JSON.stringify(makeRigConfig(name, { web, worker }, opts), null, 2)}\n`,
    "utf8",
  )

  await git(repoPath, ["init", "-b", "main"])
  await git(repoPath, ["config", "user.name", "Rig Smoke"])
  await git(repoPath, ["config", "user.email", "rig-smoke@example.test"])
  await git(repoPath, ["add", "."])
  await git(repoPath, ["commit", "-m", "feat: initial smoke fixture"])

  return {
    tempRoot,
    homeDir,
    repoPath,
    name,
    ports: { web, worker },
    cleanup: async () => {
      await killTrackedProcesses([tempRoot, homeDir, repoPath])
      await rm(tempRoot, { recursive: true, force: true })
    },
    commitAll: async (message: string) => {
      await git(repoPath, ["add", "."])
      await git(repoPath, ["commit", "-m", message])
    },
  }
}

export const createSmokeFixtureProject = async (
  fixture: SmokeFixtureSpec,
): Promise<SmokeProject> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "rig-smoke-fixture-"))
  const homeDir = join(tempRoot, "home")
  const repoPath = join(tempRoot, "repo")
  const name = fixture.name ?? fixture.rigConfig.name

  await mkdir(homeDir, { recursive: true })
  await mkdir(repoPath, { recursive: true })

  for (const file of fixture.files) {
    await writeFixtureFile(repoPath, file)
  }

  await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(fixture.rigConfig, null, 2)}\n`, "utf8")

  await git(repoPath, ["init", "-b", "main"])
  await git(repoPath, ["config", "user.name", "Rig Smoke"])
  await git(repoPath, ["config", "user.email", "rig-smoke@example.test"])
  await git(repoPath, ["add", "."])
  await git(repoPath, ["commit", "-m", "feat: initial fixture"])

  return {
    tempRoot,
    homeDir,
    repoPath,
    name,
    ports: { web: 0 },
    cleanup: async () => {
      await killTrackedProcesses([tempRoot, homeDir, repoPath])
      await rm(tempRoot, { recursive: true, force: true })
    },
    commitAll: async (message: string) => {
      await git(repoPath, ["add", "."])
      await git(repoPath, ["commit", "-m", message])
    },
  }
}

export const runSmokeCommand = async (
  project: SmokeProject,
  argv: readonly string[],
  opts?: {
    readonly cwd?: string
    readonly json?: boolean
    readonly waitForMs?: number
    readonly env?: Record<string, string | undefined>
    readonly signal?: NodeJS.Signals
  },
): Promise<SmokeCommandResult> => {
  await ensureSmokeBinaryBuilt()

  const fullArgv = opts?.json === false ? [...argv] : ["--json", ...argv]
  const cwd = opts?.cwd ?? project.repoPath
  const result = await runProcess([SMOKE_BINARY_PATH, ...fullArgv], {
    cwd,
    waitForMs: opts?.waitForMs,
    signal: opts?.signal,
    env: {
      HOME: project.homeDir,
      RIG_LOG_FILE: undefined,
      RIG_LOG_FORMAT: undefined,
      ...opts?.env,
    },
  })

  return {
    argv: fullArgv,
    cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutRecords: parseJsonLines(result.stdout),
    stderrRecords: parseJsonLines(result.stderr),
  }
}

export const helpFragmentsForCommand = (command: CommandName): readonly string[] => {
  const help = renderCommandHelp(command)
  const lines = help.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  return [lines[0] ?? command.toUpperCase(), lines[1] ?? "", "Usage:"]
}

export const mainHelpFragments = (): readonly string[] => {
  const lines = renderMainHelp().split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  return [lines[0] ?? "rig", "Commands:", "Examples:"]
}

export const firstErrorRecord = (result: SmokeCommandResult) =>
  result.stderrRecords.find((record) => record.level === "error")

export const firstTableRecord = (result: SmokeCommandResult) =>
  result.stdoutRecords.find((record) => record.level === "table")

export const infoMessages = (result: SmokeCommandResult): readonly string[] =>
  result.stdoutRecords
    .map((record) => record.message)
    .filter((message): message is string => typeof message === "string")

export const successMessages = (result: SmokeCommandResult): readonly SmokeJsonRecord[] =>
  result.stdoutRecords.filter((record) => record.level === "success")

export const appendRepoChange = async (project: SmokeProject, filename = "README.md") => {
  const path = join(project.repoPath, filename)
  const current = await readFile(path, "utf8")
  await writeFile(path, `${current}\nchange:${Date.now()}\n`, "utf8")
}
