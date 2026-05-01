import { Context, Effect, Layer } from "effect"
import { dirname } from "node:path"

import type { RigProjectConfig } from "./config.js"
import { RigConfigEditor } from "./config-editor.js"
import { RigCliArgumentError } from "./errors.js"

export interface RigProjectConfigLoadInput {
  readonly project: string
  readonly configPath: string
}

export interface RigProjectConfigLoadResult {
  readonly project: string
  readonly configPath: string
  readonly config: RigProjectConfig
}

export interface RigProjectConfigLoaderService {
  readonly load: (
    input: RigProjectConfigLoadInput,
  ) => Effect.Effect<RigProjectConfigLoadResult, RigCliArgumentError>
}

export const RigProjectConfigLoader =
  Context.Service<RigProjectConfigLoaderService>("rig/rig/RigProjectConfigLoader")

export const RigProjectConfigLoaderLive = Layer.effect(
  RigProjectConfigLoader,
  Effect.gen(function* () {
    const editor = yield* RigConfigEditor

    return {
      load: (input) =>
        editor.read(input).pipe(
          Effect.map((model) => ({
            project: model.project,
            configPath: model.configPath,
            config: {
              ...model.config,
              __sourceRepoPath: dirname(model.configPath),
            },
          })),
          Effect.mapError((error) =>
            new RigCliArgumentError(
              `Unable to load rig config for '${input.project}'.`,
              "Run from a repo with a valid rig.json before using rig runtime commands.",
              {
                project: input.project,
                configPath: input.configPath,
                originalTag: error._tag,
                cause: error.message,
                details: error.details,
              },
            ),
          ),
        ),
    } satisfies RigProjectConfigLoaderService
  }),
)
