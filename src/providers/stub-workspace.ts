import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"

import { Workspace, type Workspace as WorkspaceService, type WorkspaceInfo } from "../interfaces/workspace.js"
import type { WorkspaceError } from "../schema/errors.js"

const workspacePath = (name: string, env: string, version: string): string =>
  join(homedir(), ".rig", "workspaces", name, env, version)

export class StubWorkspace implements WorkspaceService {
  private readonly current = new Map<string, string>()

  create(name: string, env: "dev" | "prod", version: string, _commitRef: string): Effect.Effect<string, WorkspaceError> {
    const path = workspacePath(name, env, version)
    this.current.set(`${name}:${env}`, path)
    return Effect.succeed(path)
  }

  resolve(name: string, env: "dev" | "prod"): Effect.Effect<string, WorkspaceError> {
    return Effect.succeed(
      this.current.get(`${name}:${env}`) ?? workspacePath(name, env, "current"),
    )
  }

  sync(_name: string, _env: "dev" | "prod"): Effect.Effect<void, WorkspaceError> {
    return Effect.void
  }

  list(name: string): Effect.Effect<readonly WorkspaceInfo[], WorkspaceError> {
    const rows: WorkspaceInfo[] = []

    for (const env of ["dev", "prod"] as const) {
      const path = this.current.get(`${name}:${env}`)
      if (!path) {
        continue
      }

      rows.push({
        name,
        env,
        version: path.split("/").pop() ?? null,
        path,
        active: true,
      })
    }

    return Effect.succeed(rows)
  }
}

export const StubWorkspaceLive = Layer.succeed(Workspace, new StubWorkspace())
