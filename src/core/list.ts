import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import { Registry } from "../interfaces/registry.js"

export const runListCommand = () =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const registry = yield* Registry

    const entries = yield* registry.list()

    yield* logger.table(
      entries.map((entry) => ({
        name: entry.name,
        repoPath: entry.repoPath,
        registeredAt: entry.registeredAt.toISOString(),
      })),
    )

    return 0
  })
