import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"

import { Workspace, type Workspace as WorkspaceService, type WorkspaceInfo } from "../interfaces/workspace.js"
import { WorkspaceError } from "../schema/errors.js"

const workspacePath = (name: string, env: string, version: string): string =>
  join(homedir(), ".rig", "workspaces", name, env, version)

const keyFor = (name: string, env: "dev" | "prod") => `${name}:${env}`

interface StubWorkspaceOptions {
  readonly initialCurrent?: Readonly<Record<string, string>>
  readonly createFailures?: Readonly<Record<string, WorkspaceError>>
  readonly resolveFailures?: Readonly<Record<string, WorkspaceError>>
  readonly syncFailures?: Readonly<Record<string, WorkspaceError>>
}

export class StubWorkspace implements WorkspaceService {
  private readonly current = new Map<string, string>()
  readonly createCalls: Array<{ readonly name: string; readonly env: "dev" | "prod"; readonly version: string; readonly commitRef: string }> = []
  readonly resolveCalls: Array<{ readonly name: string; readonly env: "dev" | "prod" }> = []
  readonly syncCalls: Array<{ readonly name: string; readonly env: "dev" | "prod" }> = []
  readonly listCalls: string[] = []

  constructor(private readonly options: StubWorkspaceOptions = {}) {
    for (const [key, path] of Object.entries(options.initialCurrent ?? {})) {
      this.current.set(key, path)
    }
  }

  create(name: string, env: "dev" | "prod", version: string, commitRef: string): Effect.Effect<string, WorkspaceError> {
    this.createCalls.push({ name, env, version, commitRef })
    const key = keyFor(name, env)
    const failure = this.options.createFailures?.[key]
    if (failure) {
      return Effect.fail(failure)
    }

    const path = workspacePath(name, env, version)
    this.current.set(key, path)
    return Effect.succeed(path)
  }

  resolve(name: string, env: "dev" | "prod"): Effect.Effect<string, WorkspaceError> {
    this.resolveCalls.push({ name, env })
    const key = keyFor(name, env)
    const failure = this.options.resolveFailures?.[key]
    if (failure) {
      return Effect.fail(failure)
    }

    return Effect.succeed(
      this.current.get(key) ?? workspacePath(name, env, "current"),
    )
  }

  sync(name: string, env: "dev" | "prod"): Effect.Effect<void, WorkspaceError> {
    this.syncCalls.push({ name, env })
    const key = keyFor(name, env)
    const failure = this.options.syncFailures?.[key]
    if (failure) {
      return Effect.fail(failure)
    }

    return Effect.void
  }

  list(name: string): Effect.Effect<readonly WorkspaceInfo[], WorkspaceError> {
    this.listCalls.push(name)
    const rows: WorkspaceInfo[] = []

    for (const env of ["dev", "prod"] as const) {
      const path = this.current.get(keyFor(name, env))
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

  currentPath(name: string, env: "dev" | "prod"): string | undefined {
    return this.current.get(keyFor(name, env))
  }
}

export const StubWorkspaceLive = Layer.succeed(Workspace, new StubWorkspace())
