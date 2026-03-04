import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"

import type { RunOpts } from "../interfaces/service-runner.js"
import type { ServerService } from "../schema/config.js"
import { ServiceRunnerError } from "../schema/errors.js"
import { BunServiceRunner } from "./bun-service-runner.js"
import { NodeFileSystem } from "./node-fs.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect)

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const trackedPids = new Set<number>()
const trackedRoots: string[] = []

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
    runner: new BunServiceRunner(new NodeFileSystem()),
    opts: {
      workdir,
      envVars: {},
      logDir,
    },
    pidsPath: join(logDir, "..", "pids.json"),
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(async () => {
  for (const pid of trackedPids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Best-effort cleanup for already-exited processes.
    }
  }
  trackedPids.clear()

  for (const root of trackedRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe("BunServiceRunner", () => {
  // NOTE: stop() includes a PID-reuse safety guard that verifies expected listen
  // port ownership via lsof before signaling. Deterministic PID reuse is difficult
  // to simulate in unit tests, so that path is better covered in integration tests.

  test("start spawns a process, writes pid tracking, and returns RunningService", async () => {
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

  test("stop terminates process and removes it from pid tracking", async () => {
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

  test("health reports healthy for live process and unhealthy after exit", async () => {
    const { runner, opts } = await createContext()
    const service = makeService("healthcheck", "sleep 1", 3072)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

    expect(await run(runner.health(running))).toBe("healthy")

    await sleep(1_300)

    expect(await run(runner.health(running))).toBe("unhealthy")
    trackedPids.delete(running.pid)
  })

  test("logs returns tailed lines and supports opts.service filtering", async () => {
    const { runner, opts } = await createContext()
    const service = makeService("worker", "printf 'one\\ntwo\\nthree\\n'; sleep 30", 3073)

    const running = await run(runner.start(service, opts))
    trackedPids.add(running.pid)

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

  test("stop succeeds and removes PID tracking when process is already dead", async () => {
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

  test("logs returns ServiceRunnerError for unknown service", async () => {
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
})
