import { Context, Effect } from "effect-v3"
import type { EnvLoaderError } from "../schema/errors.js"

export interface EnvLoader {
  readonly load: (
    envFile: string,
    workdir: string
  ) => Effect.Effect<Readonly<Record<string, string>>, EnvLoaderError>
}

export const EnvLoader = Context.GenericTag<EnvLoader>("EnvLoader")
