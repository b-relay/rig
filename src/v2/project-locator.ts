import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect-v4"

import { V2CliArgumentError } from "./errors.js"

export interface V2LocatedProject {
  readonly name: string
  readonly repoPath: string
  readonly configPath: string
}

export interface V2ProjectLocatorService {
  readonly inferCurrentProject: Effect.Effect<V2LocatedProject, V2CliArgumentError>
}

export const V2ProjectLocator =
  Context.Service<V2ProjectLocatorService>("rig/v2/V2ProjectLocator")

const invalidCurrentRepo = (message: string, details?: Readonly<Record<string, unknown>>) =>
  new V2CliArgumentError(
    message,
    "Run the command from a managed repo or pass --project <name> explicitly.",
    details,
  )

export const V2ProjectLocatorLive = Layer.succeed(V2ProjectLocator, {
  inferCurrentProject: Effect.gen(function* () {
    const repoPath = process.cwd()
    const configPath = join(repoPath, "rig.json")
    const raw = yield* Effect.tryPromise({
      try: () => readFile(configPath, "utf8"),
      catch: (cause) =>
        invalidCurrentRepo("No rig.json found in the current directory.", {
          repoPath,
          configPath,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
    })

    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        invalidCurrentRepo("rig.json is not valid JSON.", {
          repoPath,
          configPath,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
    })

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return yield* Effect.fail(
        invalidCurrentRepo("rig.json must contain a project object.", { repoPath, configPath }),
      )
    }

    const name = (parsed as Record<string, unknown>).name
    if (typeof name !== "string" || name.trim().length === 0) {
      return yield* Effect.fail(
        invalidCurrentRepo("rig.json is missing a valid name field.", { repoPath, configPath }),
      )
    }

    return {
      name: name.trim(),
      repoPath,
      configPath,
    }
  }),
})
