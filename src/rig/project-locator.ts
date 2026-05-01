import { join } from "node:path"
import { Context, Effect, Layer } from "effect"

import { platformReadFileString } from "./effect-platform.js"
import { RigCliArgumentError } from "./errors.js"

export interface RigLocatedProject {
  readonly name: string
  readonly repoPath: string
  readonly configPath: string
}

export interface RigProjectLocatorService {
  readonly inferCurrentProject: Effect.Effect<RigLocatedProject, RigCliArgumentError>
}

export const RigProjectLocator =
  Context.Service<RigProjectLocatorService>("rig/rig/RigProjectLocator")

const invalidCurrentRepo = (message: string, details?: Readonly<Record<string, unknown>>) =>
  new RigCliArgumentError(
    message,
    "Run the command from a managed repo or pass --project <name> explicitly.",
    details,
  )

export const RigProjectLocatorLive = Layer.succeed(RigProjectLocator, {
  inferCurrentProject: Effect.gen(function* () {
    const repoPath = process.cwd()
    const configPath = join(repoPath, "rig.json")
    const raw = yield* platformReadFileString(configPath).pipe(
      Effect.mapError((cause) =>
        invalidCurrentRepo("No rig.json found in the current directory.", {
          repoPath,
          configPath,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    )

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
