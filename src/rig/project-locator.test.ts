import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { RigProjectLocator, RigProjectLocatorLive } from "./project-locator.js"

const locateCurrentProject = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const locator = yield* RigProjectLocator
      return yield* locator.inferCurrentProject
    }).pipe(Effect.provide(RigProjectLocatorLive)),
  )

describe("GIVEN rig project locator WHEN cwd is nested THEN ancestor rig.json is used", () => {
  test("GIVEN cwd below a managed repo WHEN inferring THEN nearest ancestor config is returned", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-project-locator-"))
    const repo = join(root, "pantry")
    const nested = join(repo, "apps", "web")
    const previousCwd = process.cwd()

    try {
      await mkdir(nested, { recursive: true })
      await writeFile(join(repo, "rig.json"), `${JSON.stringify({ name: "pantry" })}\n`)
      process.chdir(nested)

      const located = await locateCurrentProject()

      expect(located.name).toBe("pantry")
      expect(located.repoPath.endsWith("/pantry")).toBe(true)
      expect(located.configPath.endsWith("/pantry/rig.json")).toBe(true)
    } finally {
      process.chdir(previousCwd)
      await rm(root, { recursive: true, force: true })
    }
  })
})
