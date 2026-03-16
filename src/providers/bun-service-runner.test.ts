import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"

import type { Logger as LoggerService } from "../interfaces/logger.js"
import type { RunOpts } from "../interfaces/service-runner.js"
import type { RigError } from "../schema/errors.js"
import type { ServerService } from "../schema/config.js"
import { FileSystemError, ServiceRunnerError } from "../schema/errors.js"
import { BunServiceRunner } from "./bun-service-runner.js"
import { NodeFileSystem } from "./node-fs.js"
import { parseStructuredServiceLogEntries } from "../schema/service-log.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect)

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const isProcessGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

const parsePidLines = (raw: string): readonly number[] => {
  const pids = new Set<number>()

  for (const line of raw.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10)
    if (Number.isFinite(pid) && pid > 0) {
      pids.add(pid)
    }
  }

  return [...pids]
}

const listDirectChildPids = async (pid: number): Promise<readonly number[]> => {
  try {
    const child = Bun.spawn(["/usr/bin/pgrep", "-P", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    })

    const [stdout, exitCode] = await Promise.all([
      child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
      child.exited,
    ])

    if (exitCode !== 0) {
      return []
    }

    return parsePidLines(stdout)
  } catch {
    return []
  }
}

const listDescendantPids = async (rootPid: number): Promise<readonly number[]> => {
  const descendants = new Set<number>()
  const queue: number[] = [rootPid]

  while (queue.length > 0) {
    const parent = queue.shift()
    if (parent === undefined) {
      continue
    }

    const children = await listDirectChildPids(parent)
    for (const childPid of children) {
      if (descendants.has(childPid)) {
        continue
      }

      descendants.add(childPid)
      queue.push(childPid)
    }
  }

  return [...descendants]
}

const killProcessTree = async (pid: number): Promise<void> => {
  const descendants = await listDescendantPids(pid)

  for (const childPid of [...descendants].reverse()) {
    try {
      process.kill(childPid, "SIGKILL")
    } catch {
      // Best-effort cleanup for already-exited processes.
    }
  }

  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // Best-effort cleanup for already-exited processes.
  }
}

const waitForFile = async (path: string, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await sleep(25)
    }
  }

  throw new Error(`Timed out waiting for file: ${path}`)
}

const trackedPids = new Set<number>()
const trackedRoots: string[] = []
const NoopLogger: LoggerService = {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: (_structured: RigError) => Effect.void,
  success: () => Effect.void,
  table: () => Effect.void,
}

const makeService = (
  name: string,
  command: string,
  port: number,
): ServerService => ({
  name,
  type: "server",
  command,
  port,
  readyTimeout: 30,
})

const createContext = async (): Promise<{
  runner: BunServiceRunner
  opts: RunOpts
  pidsPath: string
}> => {
  const root = await mkdtemp(join(tmpdir(), "rig-bun-service-runner-"))
  trackedRoots.push(root)

  const workdir = join(root, "workspace")
  const logDir = join(workdir, ".rig", "logs")
  await mkdir(workdir, { recursive: true })

  return {
    runner: new BunServiceRunner(new NodeFileSystem(), NoopLogger),
    opts: {
      workdir,
      envVars: {},
      logDir,
    },
    pidsPath: join(logDir, "..", "pids.json"),
  }
}

class FailingPidWriteFileSystem extends NodeFileSystem {
  override write(path: string, content: string) {
    if (path.endsWith("/pids.json")) {
      return Effect.tryPromise({
        try: async () => {
          await sleep(500)
          throw new FileSystemError(
            "write",
            path,
            "Simulated failure while writing pid tracking.",
            "Injected by test.",
          )
        },
        catch: (cause) =>
          cause instanceof FileSystemError
            ? cause
            : new FileSystemError("write", path, String(cause), "Injected by test."),
      })
    }

    return super.write(path, content)
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(async () => {
  for (const pid of trackedPids) {
    await killProcessTree(pid)
  }
  trackedPids.clear()

  for (const root of trackedRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe("GIVEN suite context WHEN BunServiceRunner THEN behavior is covered", () => {
  // NOTE: stop() includes a PID-reuse safety guard that verifies expected listen
  // port ownership via lsof before signaling. Deterministic PID reuse is difficult
  // to simulate in unit tests, so that path is better covered in integration tests.

  test("GIVEN test setup WHEN start spawns a process, writes pid tracking, and returns RunningService THEN expected behavior is observed", async () => {
    const { runner, opts, pidsPath } = await createContext()
    const service = makeService("web", "echo $RIG_TEST_TOKEN; sleep 30", 3070)

    const running = await run(
      runner.start(service, {
        ...opts,
        envVars: { RIG_TEST_TOKEN: "service-runner-ok" },
      }),
    )
    trackedPids.add(running.pid)

    expect(running.name).toBe("web")
    expect(running.port).toBe(3070)
    expect(running.pid).toBeGreaterThan(0)
    expect(running.startedAt).toBeInstanceOf(Date)

    const pidsRaw = await readFile(pidsPath, "utf8")
    const pids = JSON.parse(pidsRaw) as Record<string, { pid: number; port: number; startedAt: string }>
    expect(pids.web.pid).toBe(running.pid)
    expect(pids.web.port).toBe(3070)
    expect(new Date(pids.web.startedAt).toString()).not.toBe("Invalid Date")
  })

  test("GIVEN a service start WHEN foreground is false THEN child processes are unrefed", async () => {
    const { runner, opts } = await createContext()
    const service = makeService("unref-check", "sleep 30", 3081)
    const originalSpawn = Bun.spawn
    let unrefCalled = false
    const fakePid = 654_321

    Bun.spawn = ((_command: Parameters<typeof Bun.spawn>[0], _options?: Parameters<typeof Bun.spawn>[1]) =>
      ({
        pid: fakePid,
        unref: () => {
          unrefCalled = true
        },
      }) as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn

    try {
      const running = await run(runner.start(service, opts))
      expect(running.pid).toBe(fakePid)
      expect(unrefCalled).toBe(true)
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  test("GIVEN test setup WHEN stop terminates process and removes it from pid tracking THEN expected behavior is observed", async () => {
    const { runner, opts, pidsPath } = await createContext()
    const service = makeService("api", "sleep 30", 3071)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

    await run(runner.stop(running))
    trackedPids.delete(running.pid)

    const health = await run(runner.health(running))
    expect(health).toBe("unhealthy")

    const pidsRaw = await readFile(pidsPath, "utf8")
    const pids = JSON.parse(pidsRaw) as Record<string, unknown>
    expect("api" in pids).toBe(false)
  })

  test("GIVEN a service command spawns child processes WHEN stop is called THEN parent, child, and process group all terminate", async () => {
    const { runner, opts, pidsPath } = await createContext()
    const childPidPath = join(opts.workdir, ".child.pid")
    const service = makeService(
      "with-child",
      `sleep 30 & echo $! > ${JSON.stringify(childPidPath)}; wait`,
      3079,
    )

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)
    await waitForFile(childPidPath)

    const childPid = Number.parseInt((await readFile(childPidPath, "utf8")).trim(), 10)
    expect(Number.isFinite(childPid)).toBe(true)
    trackedPids.add(childPid)

    expect(isProcessAlive(running.pid)).toBe(true)
    expect(isProcessAlive(childPid)).toBe(true)
    expect(isProcessGroupAlive(running.pid)).toBe(true)

    await run(runner.stop(running))
    trackedPids.delete(running.pid)
    trackedPids.delete(childPid)

    await sleep(250)
    expect(isProcessAlive(running.pid)).toBe(false)
    expect(isProcessAlive(childPid)).toBe(false)
    expect(isProcessGroupAlive(running.pid)).toBe(false)

    const pidsRaw = await readFile(pidsPath, "utf8")
    const pids = JSON.parse(pidsRaw) as Record<string, unknown>
    expect("with-child" in pids).toBe(false)
  })

  test("GIVEN test setup WHEN health reports healthy for live process and unhealthy after exit THEN expected behavior is observed", async () => {
    const { runner, opts } = await createContext()
    const service = makeService("healthcheck", "sleep 1", 3072)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

    expect(await run(runner.health(running))).toBe("healthy")

    let health = await run(runner.health(running))
    for (let index = 0; index < 30 && health !== "unhealthy"; index += 1) {
      await sleep(100)
      health = await run(runner.health(running))
    }

    expect(health).toBe("unhealthy")
    trackedPids.delete(running.pid)
  })

  test("GIVEN test setup WHEN logs returns tailed lines and supports opts.service filtering THEN expected behavior is observed", async () => {
    const { runner, opts } = await createContext()
    const service = makeService("worker", "printf 'one\\ntwo\\nthree\\n'; sleep 30", 3073)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

    await waitForFile(join(opts.logDir, "worker.log.jsonl"))
    await sleep(250)

    const tailed = await run(
      runner.logs("worker", {
        follow: false,
        lines: 2,
      }),
    )
    expect(tailed).toBe("two\nthree")

    const filtered = await run(
      runner.logs("project", {
        follow: true,
        lines: 1,
        service: "worker",
      }),
    )
    expect(filtered).toBe("three")
  })

  test("GIVEN a started service WHEN it writes output THEN a structured per-line log file is recorded alongside the raw log", async () => {
    const { runner, opts } = await createContext()
    const service = makeService("structured-log", "printf 'alpha\\nbeta\\n'; sleep 30", 3079)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

    const structuredPath = join(opts.logDir, "structured-log.log.jsonl")
    await waitForFile(structuredPath)
    await sleep(250)

    const content = await readFile(structuredPath, "utf8")
    const entries = parseStructuredServiceLogEntries(content)

    expect(entries.map((entry) => entry.message)).toEqual(["alpha", "beta"])
    expect(entries.every((entry) => entry.service === "structured-log")).toBe(true)
    expect(entries.every((entry) => entry.stream === "stdout")).toBe(true)
  })

  test("GIVEN test setup WHEN stop succeeds and removes PID tracking when process is already dead THEN expected behavior is observed", async () => {
    const { runner, opts, pidsPath } = await createContext()
    const service = makeService("gone", "echo done", 3074)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

    // Wait for the short-lived process to exit naturally
    await sleep(250)

    // stop() should succeed (idempotent) and clean up PID tracking
    await run(runner.stop(running))

    const pidsRaw = await readFile(pidsPath, "utf8")
    const pids = JSON.parse(pidsRaw) as Record<string, unknown>
    expect("gone" in pids).toBe(false)

    trackedPids.delete(running.pid)
  })

  test("GIVEN test setup WHEN logs returns ServiceRunnerError for unknown service THEN expected behavior is observed", async () => {
    const { runner } = await createContext()

    const result = await run(
      runner.logs("missing", {
        follow: false,
        lines: 10,
      }).pipe(Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ServiceRunnerError)
      expect(result.left.operation).toBe("logs")
      expect(result.left.service).toBe("missing")
    }
  })

  test("GIVEN pid tracking write failure WHEN start already spawned a process THEN runner cleans up the spawned process", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-bun-service-runner-cleanup-"))
    trackedRoots.push(root)

    const workdir = join(root, "workspace")
    const logDir = join(workdir, ".rig", "logs")
    await mkdir(workdir, { recursive: true })

    const parentPidPath = join(workdir, ".spawned-parent.pid")
    const childPidPath = join(workdir, ".spawned-child.pid")
    const runner = new BunServiceRunner(new FailingPidWriteFileSystem(), NoopLogger)
    const service = makeService(
      "cleanup",
      `echo $$ > ${JSON.stringify(parentPidPath)}; sleep 30 & echo $! > ${JSON.stringify(childPidPath)}; wait`,
      3075,
    )

    const result = await run(
      runner.start(service, { workdir, envVars: {}, logDir }).pipe(Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ServiceRunnerError)
      expect(result.left.operation).toBe("start")
    }

    await waitForFile(parentPidPath)
    await waitForFile(childPidPath)
    const parentPid = Number.parseInt((await readFile(parentPidPath, "utf8")).trim(), 10)
    const childPid = Number.parseInt((await readFile(childPidPath, "utf8")).trim(), 10)
    expect(Number.isFinite(parentPid)).toBe(true)
    expect(Number.isFinite(childPid)).toBe(true)
    trackedPids.add(parentPid)
    trackedPids.add(childPid)

    await sleep(300)
    expect(isProcessAlive(parentPid)).toBe(false)
    expect(isProcessAlive(childPid)).toBe(false)
    expect(isProcessGroupAlive(parentPid)).toBe(false)
    trackedPids.delete(parentPid)
    trackedPids.delete(childPid)
  })

  test("GIVEN two services are started WHEN pid tracking is updated across stop calls THEN pids.json reflects both and then each removal", async () => {
    const { runner, opts, pidsPath } = await createContext()
    const api = makeService("api-multi", "sleep 30", 4071)
    const web = makeService("web-multi", "sleep 30", 4072)

    const apiRunning = await run(runner.start(api, opts))
    const webRunning = await run(runner.start(web, opts))
    trackedPids.add(apiRunning.pid)
    trackedPids.add(webRunning.pid)

    const bothRaw = await readFile(pidsPath, "utf8")
    const both = JSON.parse(bothRaw) as Record<string, { pid: number }>
    expect(both["api-multi"]?.pid).toBe(apiRunning.pid)
    expect(both["web-multi"]?.pid).toBe(webRunning.pid)

    await run(runner.stop(apiRunning))
    trackedPids.delete(apiRunning.pid)

    const afterFirstStopRaw = await readFile(pidsPath, "utf8")
    const afterFirstStop = JSON.parse(afterFirstStopRaw) as Record<string, { pid: number }>
    expect(afterFirstStop["api-multi"]).toBeUndefined()
    expect(afterFirstStop["web-multi"]?.pid).toBe(webRunning.pid)

    await run(runner.stop(webRunning))
    trackedPids.delete(webRunning.pid)

    const afterSecondStopRaw = await readFile(pidsPath, "utf8")
    const afterSecondStop = JSON.parse(afterSecondStopRaw) as Record<string, unknown>
    expect(Object.keys(afterSecondStop)).toHaveLength(0)
  })

  test("GIVEN malformed pids.json WHEN start reads pid tracking THEN start fails with a parse ServiceRunnerError", async () => {
    const { runner, opts, pidsPath } = await createContext()
    const service = makeService("corrupt-pids", "echo started", 4073)

    await mkdir(join(opts.logDir, ".."), { recursive: true })
    await writeFile(pidsPath, "{not-json", "utf8")

    const result = await run(runner.start(service, opts).pipe(Effect.either))

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ServiceRunnerError)
      expect(result.left.operation).toBe("start")
      expect(result.left.service).toBe("corrupt-pids")
      expect(result.left.message).toContain("Failed to parse PID tracking file")
    }
  })

  test("GIVEN pids.json contains an array WHEN start reads pid tracking THEN start fails with invalid shape ServiceRunnerError", async () => {
    const { runner, opts, pidsPath } = await createContext()
    const service = makeService("array-pids", "echo started", 4074)

    await mkdir(join(opts.logDir, ".."), { recursive: true })
    await writeFile(pidsPath, "[1,2,3]\n", "utf8")

    const result = await run(runner.start(service, opts).pipe(Effect.either))

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ServiceRunnerError)
      expect(result.left.operation).toBe("start")
      expect(result.left.service).toBe("array-pids")
      expect(result.left.message).toContain("Expected a JSON object keyed by service name.")
    }
  })

  test("GIVEN a service has already been stopped WHEN stop is called a second time THEN the operation is idempotent and succeeds", async () => {
    const { runner, opts, pidsPath } = await createContext()
    const service = makeService("double-stop", "sleep 30", 4075)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

    await run(runner.stop(running))
    trackedPids.delete(running.pid)

    await run(runner.stop(running))
    expect(await run(runner.health(running))).toBe("unhealthy")

    const pidsRaw = await readFile(pidsPath, "utf8")
    const pids = JSON.parse(pidsRaw) as Record<string, unknown>
    expect("double-stop" in pids).toBe(false)
  })

  test("GIVEN tailLines edge inputs WHEN logs is requested THEN empty output, zero lines, and oversized requests are handled safely", async () => {
    const { runner, opts } = await createContext()
    const quiet = makeService("quiet-tail", "sleep 30", 4076)
    const small = makeService("small-tail", "printf 'alpha\\nbeta\\n'; sleep 30", 4077)

    const quietRunning = await run(runner.start(quiet, opts))
    const smallRunning = await run(runner.start(small, opts))
    trackedPids.add(quietRunning.pid)
    trackedPids.add(smallRunning.pid)

    await waitForFile(join(opts.logDir, "quiet-tail.log"))
    await sleep(200)

    const quietLogs = await run(
      runner.logs("quiet-tail", {
        follow: false,
        lines: 20,
      }),
    )
    expect(quietLogs).toBe("")

    const zeroLineLogs = await run(
      runner.logs("small-tail", {
        follow: false,
        lines: 0,
      }),
    )
    expect(zeroLineLogs).toBe("")

    const oversizedLogs = await run(
      runner.logs("small-tail", {
        follow: false,
        lines: 10,
      }),
    )
    expect(oversizedLogs).toBe("alpha\nbeta")
  })

  test("GIVEN process env already defines HOME WHEN start passes HOME override in envVars THEN command output uses the override value", async () => {
    const { runner, opts } = await createContext()
    const service = makeService("env-override", "echo $HOME; sleep 30", 4078)
    const overrideHome = `${opts.workdir}/custom-home`

    const running = await run(
      runner.start(service, {
        ...opts,
        envVars: { HOME: overrideHome },
      }),
    )
    trackedPids.add(running.pid)

    await waitForFile(join(opts.logDir, "env-override.log.jsonl"))
    await sleep(250)

    const logs = await run(
      runner.logs("env-override", {
        follow: false,
        lines: 1,
      }),
    )
    expect(logs).toBe(overrideHome)
  })

  test("GIVEN a service writes to stderr WHEN logs are read THEN stderr content is captured in the service log file", async () => {
    const { runner, opts } = await createContext()
    const service = makeService("stderr-log", "echo err-output >&2; sleep 30", 4079)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

    await waitForFile(join(opts.logDir, "stderr-log.log.jsonl"))
    await sleep(250)

    const logs = await run(
      runner.logs("stderr-log", {
        follow: false,
        lines: 10,
      }),
    )
    expect(logs).toContain("err-output")
  })

  test("GIVEN start launches a command that exits immediately WHEN health is checked shortly after THEN the service reports unhealthy", async () => {
    const { runner, opts } = await createContext()
    const service = makeService("bad-command", "nonexistent-binary-xyz", 4080)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

    let health = await run(runner.health(running))
    for (let index = 0; index < 20 && health !== "unhealthy"; index += 1) {
      await sleep(50)
      health = await run(runner.health(running))
    }

    expect(health).toBe("unhealthy")
    trackedPids.delete(running.pid)
  })
})
