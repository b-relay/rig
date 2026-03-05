import { resolve } from "node:path"
import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import { Registry } from "../interfaces/registry.js"
import type { InitArgs } from "../schema/args.js"

export const runInitCommand = (args: InitArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const registry = yield* Registry

    const repoPath = resolve(args.path)

    yield* registry.register(args.name, repoPath)
    yield* logger.success(`Registered ${args.name} at ${repoPath}`, {
      name: args.name,
      repoPath,
    })

    return 0
  })
