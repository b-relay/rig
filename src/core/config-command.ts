import { Effect } from "effect"
import { z } from "zod"

import { Logger } from "../interfaces/logger.js"
import { RigConfigSchema } from "../schema/config.js"

const rootFields = (() => {
  const object = RigConfigSchema as z.ZodObject<z.ZodRawShape>
  return Object.keys(object.shape)
})()

export const runConfigCommand = () =>
  Effect.gen(function* () {
    const logger = yield* Logger

    yield* logger.info("rig.json schema reference", {
      description: RigConfigSchema.description ?? "Root rig.json configuration schema.",
      fields: rootFields,
    })

    return 0
  })
