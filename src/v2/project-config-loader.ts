import { Context, Effect, Layer } from "effect-v4"

import type { V2ProjectConfig } from "./config.js"
import { V2ConfigEditor } from "./config-editor.js"
import { V2CliArgumentError } from "./errors.js"

export interface V2ProjectConfigLoadInput {
  readonly project: string
  readonly configPath: string
}

export interface V2ProjectConfigLoadResult {
  readonly project: string
  readonly configPath: string
  readonly config: V2ProjectConfig
}

export interface V2ProjectConfigLoaderService {
  readonly load: (
    input: V2ProjectConfigLoadInput,
  ) => Effect.Effect<V2ProjectConfigLoadResult, V2CliArgumentError>
}

export const V2ProjectConfigLoader =
  Context.Service<V2ProjectConfigLoaderService>("rig/v2/V2ProjectConfigLoader")

export const V2ProjectConfigLoaderLive = Layer.effect(
  V2ProjectConfigLoader,
  Effect.gen(function* () {
    const editor = yield* V2ConfigEditor

    return {
      load: (input) =>
        editor.read(input).pipe(
          Effect.map((model) => ({
            project: model.project,
            configPath: model.configPath,
            config: model.config,
          })),
          Effect.mapError((error) =>
            new V2CliArgumentError(
              `Unable to load v2 config for '${input.project}'.`,
              "Run from a repo with a valid v2 rig.json before using rig2 runtime commands.",
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
    } satisfies V2ProjectConfigLoaderService
  }),
)
