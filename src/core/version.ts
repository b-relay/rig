import { Effect } from "effect"

import { Git } from "../interfaces/git.js"
import { Logger } from "../interfaces/logger.js"
import type { VersionArgs } from "../schema/args.js"
import { loadProjectConfig } from "./config.js"

export const runVersionCommand = (args: VersionArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const git = yield* Git

    const loaded = yield* loadProjectConfig(args.name)
    const branch = yield* git.currentBranch(loaded.repoPath)
    const commit = yield* git.commitHash(loaded.repoPath)
    const dirty = yield* git.isDirty(loaded.repoPath)

    yield* logger.info("Version command resolved state.", {
      name: args.name,
      action: args.action,
      version: loaded.config.version,
      branch,
      commit,
      dirty,
    })

    return 0
  })
