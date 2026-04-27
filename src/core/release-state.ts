import { Effect } from "effect-v3"

import { Workspace } from "../interfaces/workspace.js"
import { latestReleaseVersion } from "./release.js"

export interface ProdReleaseState {
  readonly latestProdVersion: string | null
  readonly currentProdVersion: string | null
}

export const resolveProdReleaseState = (name: string, repoPath: string) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace
    const latestProdVersion = yield* latestReleaseVersion(repoPath).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
    const workspaces = yield* workspace.list(name)

    return {
      latestProdVersion,
      currentProdVersion:
        workspaces.find((entry) => entry.env === "prod" && entry.active)?.version ?? null,
    } satisfies ProdReleaseState
  })
