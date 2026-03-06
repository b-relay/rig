import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { PortChecker } from "../interfaces/port-checker.js"
import { PortConflictError } from "../schema/errors.js"
import { BunPortCheckerLive } from "./bun-port-checker.js"

const HIGH_PORT_MIN = 49_152
const HIGH_PORT_MAX = 65_535

const randomHighPort = (): number =>
  Math.floor(Math.random() * (HIGH_PORT_MAX - HIGH_PORT_MIN + 1)) +
  HIGH_PORT_MIN

type ListenerHandle = { stop: (closeActiveConnections?: boolean) => void }

const activeListeners: ListenerHandle[] = []

const listenOnRandomHighPort = (): {
  listener: ListenerHandle
  port: number
} => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = randomHighPort()

    try {
      const listener: ListenerHandle = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      })

      activeListeners.push(listener)
      return { listener, port }
    } catch {
      // Retry until an available random high port is found.
    }
  }

  throw new Error("Failed to bind an available random high port after 50 attempts")
}

const reserveFreeRandomHighPort = (): number => {
  const { listener, port } = listenOnRandomHighPort()
  listener.stop(true)
  const index = activeListeners.indexOf(listener)
  if (index >= 0) {
    activeListeners.splice(index, 1)
  }
  return port
}

const checkEffect = (port: number, service: string) =>
  Effect.gen(function* () {
    const checker = yield* PortChecker
    return yield* checker.check(port, service)
  }).pipe(Effect.provide(BunPortCheckerLive))

afterEach(() => {
  for (const listener of activeListeners.splice(0)) {
    try {
      listener.stop(true)
    } catch {
      // Best-effort cleanup for already-closed listeners.
    }
  }
})

describe("GIVEN suite context WHEN BunPortCheckerLive THEN behavior is covered", () => {
  test("GIVEN port is free WHEN check runs THEN succeeds without error", async () => {
    const port = reserveFreeRandomHighPort()

    await Effect.runPromise(checkEffect(port, "web"))
  })

  test("GIVEN port is in use WHEN check runs THEN fails with PortConflictError", async () => {
    const { port } = listenOnRandomHighPort()

    const result = await Effect.runPromise(
      checkEffect(port, "api").pipe(Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PortConflictError)
    }
  })

  test("GIVEN port is in use WHEN check runs THEN PortConflictError contains correct port and service name", async () => {
    const { port } = listenOnRandomHighPort()

    const result = await Effect.runPromise(
      checkEffect(port, "search").pipe(Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      const error = result.left
      expect(error).toBeInstanceOf(PortConflictError)
      if (error instanceof PortConflictError) {
        expect(error.port).toBe(port)
        expect(error.service).toBe("search")
      }
    }
  })

  test("GIVEN port is in use by known PID WHEN check runs THEN error includes PID in hint", async () => {
    const { port } = listenOnRandomHighPort()
    const originalSpawn = Bun.spawn
    Bun.spawn = ((...args: unknown[]) => {
      const [cmd] = args as [unknown]
      const argv = Array.isArray(cmd) ? cmd.map(String) : []
      if (argv[0] === "lsof") {
        const stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${process.pid}\n`))
            controller.close()
          },
        })

        return {
          stdout,
          exited: Promise.resolve(0),
        } as ReturnType<typeof Bun.spawn>
      }

      return (originalSpawn as (...innerArgs: unknown[]) => ReturnType<typeof Bun.spawn>)(...args)
    }) as typeof Bun.spawn

    try {
      const result = await Effect.runPromise(
        checkEffect(port, "pid-check").pipe(Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        const error = result.left
        expect(error).toBeInstanceOf(PortConflictError)
        if (error instanceof PortConflictError) {
          expect(error.existingPid).toBe(process.pid)
          expect(error.hint).toContain(`pid ${process.pid}`)
        }
      }
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  test("GIVEN checking port 0 (OS-assigned) WHEN check runs THEN succeeds", async () => {
    await Effect.runPromise(checkEffect(0, "zero-port"))
  })

  test("GIVEN two consecutive checks on same free port WHEN both run THEN both succeed", async () => {
    const port = reserveFreeRandomHighPort()

    await Effect.runPromise(checkEffect(port, "double-check"))
    await Effect.runPromise(checkEffect(port, "double-check"))
  })
})
