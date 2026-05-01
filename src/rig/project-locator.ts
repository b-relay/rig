import { dirname, join, parse } from "node:path"
import { Context, Effect, Layer } from "effect"

import { isPlatformNotFound, platformReadFileString } from "./effect-platform.js"
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
    const startPath = process.cwd()
    const rootPath = parse(startPath).root
    let repoPath = startPath
    let configPath = join(repoPath, "rig.json")
    let raw: string | undefined

    while (true) {
      const attemptPath = join(repoPath, "rig.json")
      const attempt = yield* platformReadFileString(attemptPath).pipe(
        Effect.matchEffect({
          onSuccess: (content) => Effect.succeed({ ok: true as const, content }),
          onFailure: (error) => Effect.succeed({ ok: false as const, error }),
        }),
      )
      if (attempt.ok) {
        configPath = attemptPath
        raw = attempt.content
        break
      }
      if (!isPlatformNotFound(attempt.error)) {
        return yield* Effect.fail(
          invalidCurrentRepo("Unable to read rig.json from the current repo.", {
            repoPath,
            configPath: attemptPath,
            cause: attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
          }),
        )
      }
      if (repoPath === rootPath) {
        return yield* Effect.fail(
          invalidCurrentRepo("No rig.json found in the current directory or its ancestors.", {
            repoPath: startPath,
            configPath: join(startPath, "rig.json"),
          }),
        )
      }
      repoPath = dirname(repoPath)
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw as string) as unknown,
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
