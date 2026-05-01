import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun"

const repoRoot = process.cwd()
const rigRoot = join(repoRoot, "src", "rig")

const rigSourceFiles = async (dir: string): Promise<readonly string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return rigSourceFiles(path)
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : []
  }))
  return files.flat()
}

describe("GIVEN Rig Effect Platform packages WHEN child processes run THEN package versions share Effect v4", () => {
  test("GIVEN the Bun child process spawner WHEN a command exits THEN rig receives pid and exit code", async () => {
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

  test("GIVEN rig runtime source WHEN scanned THEN direct Bun APIs are not used", async () => {
    const violations: string[] = []
    for (const file of await rigSourceFiles(rigRoot)) {
      const relative = file.slice(repoRoot.length + 1)
      if (relative.endsWith("effect-platform-version.test.ts")) {
        continue
      }
      const text = await readFile(file, "utf8")
      if (/\bBun\./.test(text)) {
        violations.push(relative)
      }
    }

    expect(violations).toEqual([])
  })

  test("GIVEN rig runtime source WHEN scanned THEN production code does not import node fs APIs", async () => {
    const violations: string[] = []
    for (const file of await rigSourceFiles(rigRoot)) {
      const relative = file.slice(repoRoot.length + 1)
      if (relative.endsWith(".test.ts")) {
        continue
      }
      const text = await readFile(file, "utf8")
      if (/from\s+["']node:fs(?:\/promises)?["']/.test(text) || /from\s+["']fs(?:\/promises)?["']/.test(text)) {
        violations.push(relative)
      }
    }

    expect(violations).toEqual([])
  })
})
