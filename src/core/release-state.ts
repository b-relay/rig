import { Effect } from "effect"

import { Workspace } from "../interfaces/workspace.js"
import { loadVersionHistory } from "./release.js"

export interface ProdReleaseState {
  readonly latestProdVersion: string | null
  readonly currentProdVersion: string | null
}

export const resolveProdReleaseState = (name: string, repoPath: string) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace
    const history = yield* loadVersionHistory(repoPath, name)
    const workspaces = yield* workspace.list(name)

    return {
      latestProdVersion: history.entries.at(-1)?.newVersion ?? null,
      currentProdVersion:
        workspaces.find((entry) => entry.env === "prod" && entry.active)?.version ?? null,
    } satisfies ProdReleaseState
  })
