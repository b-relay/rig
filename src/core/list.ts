import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import { Registry } from "../interfaces/registry.js"
import { resolveProdReleaseState } from "./release-state.js"

export const runListCommand = () =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const registry = yield* Registry

    const entries = yield* registry.list()

    yield* logger.table(
      yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const releaseState = yield* resolveProdReleaseState(entry.name, entry.repoPath)

          return {
            name: entry.name,
            repoPath: entry.repoPath,
            currentProdVersion: releaseState.currentProdVersion ?? "N/A",
            registeredAt: entry.registeredAt.toISOString(),
          }
        }),
      ),
    )

    return 0
  })
