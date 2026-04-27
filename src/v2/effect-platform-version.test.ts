import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun"

describe("GIVEN Rig v2 Effect Platform packages WHEN child processes run THEN package versions share Effect v4", () => {
  test("GIVEN the Bun child process spawner WHEN a command exits THEN v2 receives pid and exit code", async () => {
    const platformLayer = Layer.provide(
      BunChildProcessSpawner.layer,
      Layer.merge(BunFileSystem.layer, BunPath.layer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make("sh", ["-lc", "exit 0"])
        const running = yield* handle.isRunning
        const exitCode = yield* handle.exitCode

        return {
          pid: Number(handle.pid),
          running,
          exitCode: Number(exitCode),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(platformLayer),
      ),
    )

    expect(result.pid).toBeGreaterThan(0)
    expect(result.running).toBeBoolean()
    expect(result.exitCode).toBe(0)
  })
})
