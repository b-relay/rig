import { join, basename } from "node:path"
import { readlink } from "node:fs/promises"
import { Effect, Layer } from "effect"

import { rigWorkspacesRoot } from "../core/rig-paths.js"
import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Git, type Git as GitService } from "../interfaces/git.js"
import { Registry, type Registry as RegistryService } from "../interfaces/registry.js"
import { Workspace, type Workspace as WorkspaceService, type WorkspaceInfo } from "../interfaces/workspace.js"
import { WorkspaceError } from "../schema/errors.js"

// ── Paths ────────────────────────────────────────────────────────────────────

const rigBase = () => rigWorkspacesRoot()

const workspacePath = (name: string, env: string, version?: string): string =>
  version
    ? join(rigBase(), name, env, version)
    : join(rigBase(), name, env)

const currentSymlink = (name: string): string =>
  join(rigBase(), name, "prod", "current")

// ── Helpers ──────────────────────────────────────────────────────────────────

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const toWorkspaceError = (
  operation: WorkspaceError["operation"],
  name: string,
  env: string,
  hint: string,
) =>
  (cause: unknown) =>
    new WorkspaceError(operation, name, env, causeMessage(cause), hint)

// ── Implementation ───────────────────────────────────────────────────────────

export class GitWorktreeWorkspace implements WorkspaceService {
  constructor(
    private readonly git: GitService,
    private readonly fs: FileSystemService,
    private readonly registry: RegistryService,
  ) {}

  create(
    name: string,
    env: "dev" | "prod",
    version: string,
    commitRef: string,
  ): Effect.Effect<string, WorkspaceError> {
    if (env === "dev") {
      return this.createDev(name)
    }

    return this.createProd(name, version, commitRef)
  }

  resolve(name: string, env: "dev" | "prod", version?: string): Effect.Effect<string, WorkspaceError> {
    if (env === "dev") {
      return this.resolveDev(name)
    }

    return this.resolveProd(name, version)
  }

  activate(name: string, env: "dev" | "prod", version: string): Effect.Effect<string, WorkspaceError> {
    if (env === "dev") {
      return Effect.fail(
        new WorkspaceError(
          "resolve",
          name,
          env,
          "Dev workspaces are not versioned.",
          "Use dev without a version selector.",
        ),
      )
    }

    return this.activateProd(name, version)
  }

  removeVersion(name: string, env: "dev" | "prod", version: string): Effect.Effect<void, WorkspaceError> {
    if (env === "dev") {
      return Effect.fail(
        new WorkspaceError(
          "resolve",
          name,
          env,
          "Dev workspaces are not versioned.",
          "Use dev without version removal.",
        ),
      )
    }

    return this.removeProdVersion(name, version)
  }

  renameVersion(
    name: string,
    env: "dev" | "prod",
    fromVersion: string,
    toVersion: string,
  ): Effect.Effect<string, WorkspaceError> {
    if (env === "dev") {
      return Effect.fail(
        new WorkspaceError(
          "resolve",
          name,
          env,
          "Dev workspaces are not versioned.",
          "Use dev without version renames.",
        ),
      )
    }

    return this.renameProdVersion(name, fromVersion, toVersion)
  }

  sync(_name: string, _env: "dev" | "prod"): Effect.Effect<void, WorkspaceError> {
    // Dev runs from repo directly — nothing to sync.
    // Prod runs from immutable worktrees — nothing to sync.
    return Effect.void
  }

  list(name: string): Effect.Effect<readonly WorkspaceInfo[], WorkspaceError> {
    return Effect.gen(this, function* () {
      const rows: WorkspaceInfo[] = []
      const projectBase = join(rigBase(), name)

      // Dev workspace
      const devPath = join(projectBase, "dev")
      const devExists = yield* this.fs.exists(devPath).pipe(
        Effect.mapError(toWorkspaceError("list", name, "dev", "Unable to check dev workspace.")),
      )

      if (devExists) {
        const repoPath = yield* this.registry.resolve(name).pipe(
          Effect.mapError((cause) =>
            new WorkspaceError("list", name, "dev", causeMessage(cause), "Register project first."),
          ),
        )

        rows.push({
          name,
          env: "dev",
          version: null,
          path: repoPath,
          active: true,
        })
      }

      // Prod workspaces
      const prodBase = join(projectBase, "prod")
      const prodExists = yield* this.fs.exists(prodBase).pipe(
        Effect.mapError(toWorkspaceError("list", name, "prod", "Unable to check prod workspace.")),
      )

      if (prodExists) {
        // Read the current symlink target to find the active version
        const activePath = yield* Effect.tryPromise({
          try: () => readlink(currentSymlink(name)),
          catch: () => null as unknown,
        }).pipe(Effect.catchAll(() => Effect.succeed(null as string | null)))

        const activeVersion = activePath ? basename(activePath) : null

        const entries = yield* this.fs.list(prodBase).pipe(
          Effect.mapError(toWorkspaceError("list", name, "prod", "Unable to list prod workspaces.")),
        )

        for (const entry of entries) {
          if (entry === "current") continue

          rows.push({
            name,
            env: "prod",
            version: entry,
            path: join(prodBase, entry),
            active: entry === activeVersion,
          })
        }
      }

      return rows
    })
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private createDev(name: string): Effect.Effect<string, WorkspaceError> {
    return Effect.gen(this, function* () {
      const repoPath = yield* this.registry.resolve(name).pipe(
        Effect.mapError((cause) =>
          new WorkspaceError(
            "create",
            name,
            "dev",
            causeMessage(cause),
            "Register the project first with `rig init`.",
          ),
        ),
      )

      // Ensure the dev workspace dir exists for runtime state (pids.json, logs/)
      const devDir = workspacePath(name, "dev")
      yield* this.fs.mkdir(devDir).pipe(
        Effect.mapError(toWorkspaceError("create", name, "dev", `Unable to create ${devDir}.`)),
      )

      return repoPath
    })
  }

  private createProd(
    name: string,
    version: string,
    commitRef: string,
  ): Effect.Effect<string, WorkspaceError> {
    return Effect.gen(this, function* () {
      const repoPath = yield* this.registry.resolve(name).pipe(
        Effect.mapError((cause) =>
          new WorkspaceError(
            "create",
            name,
            "prod",
            causeMessage(cause),
            "Register the project first with `rig init`.",
          ),
        ),
      )

      const dest = workspacePath(name, "prod", version)

      // Check if worktree already exists
      const exists = yield* this.fs.exists(dest).pipe(
        Effect.mapError(toWorkspaceError("create", name, "prod", `Unable to check ${dest}.`)),
      )

      if (exists) {
        return yield* Effect.fail(
          new WorkspaceError(
            "create",
            name,
            "prod",
            `Workspace already exists at ${dest}.`,
            `Version ${version} is already deployed. Bump version first.`,
          ),
        )
      }

      // Ensure parent directory exists
      const prodBase = workspacePath(name, "prod")
      yield* this.fs.mkdir(prodBase).pipe(
        Effect.mapError(toWorkspaceError("create", name, "prod", `Unable to create ${prodBase}.`)),
      )

      // Create git worktree at the tagged commit
      yield* this.git.createWorktree(repoPath, dest, commitRef).pipe(
        Effect.mapError((gitErr) =>
          new WorkspaceError(
            "create",
            name,
            "prod",
            `Git worktree creation failed: ${gitErr.message}`,
            `Ensure ref '${commitRef}' exists. ${gitErr.hint}`,
          ),
        ),
      )

      // Update the current symlink
      yield* this.fs.symlink(dest, currentSymlink(name)).pipe(
        Effect.mapError(
          toWorkspaceError("create", name, "prod", "Unable to update current symlink."),
        ),
      )

      return dest
    })
  }

  private resolveDev(name: string): Effect.Effect<string, WorkspaceError> {
    return this.registry.resolve(name).pipe(
      Effect.mapError((cause) =>
        new WorkspaceError(
          "resolve",
          name,
          "dev",
          causeMessage(cause),
          "Register the project first with `rig init`.",
        ),
      ),
    )
  }

  private resolveProd(name: string, version?: string): Effect.Effect<string, WorkspaceError> {
    if (version) {
      const path = workspacePath(name, "prod", version)
      return this.fs.exists(path).pipe(
        Effect.mapError(
          toWorkspaceError("resolve", name, "prod", `Unable to check prod workspace ${path}.`),
        ),
        Effect.flatMap((exists) =>
          exists
            ? Effect.succeed(path)
            : Effect.fail(
                new WorkspaceError(
                  "resolve",
                  name,
                  "prod",
                  `No deployed prod workspace found for version '${version}'.`,
                  `Deploy version ${version} first or choose an existing prod version.`,
                ),
              ),
        ),
      )
    }

    const symlink = currentSymlink(name)

    return Effect.tryPromise({
      try: () => readlink(symlink),
      catch: toWorkspaceError(
        "resolve",
        name,
        "prod",
        `No active prod deployment. Run \`rig deploy ${name} --prod\` first.`,
      ),
    })
  }

  private activateProd(name: string, version: string): Effect.Effect<string, WorkspaceError> {
    return Effect.gen(this, function* () {
      const path = yield* this.resolveProd(name, version)
      yield* this.fs.symlink(path, currentSymlink(name)).pipe(
        Effect.mapError(
          toWorkspaceError("create", name, "prod", "Unable to update current symlink."),
        ),
      )
      return path
    })
  }

  private removeProdVersion(name: string, version: string): Effect.Effect<void, WorkspaceError> {
    return Effect.gen(this, function* () {
      const repoPath = yield* this.registry.resolve(name).pipe(
        Effect.mapError((cause) =>
          new WorkspaceError(
            "remove",
            name,
            "prod",
            causeMessage(cause),
            "Register the project first with `rig init`.",
          ),
        ),
      )

      const path = workspacePath(name, "prod", version)
      const exists = yield* this.fs.exists(path).pipe(
        Effect.mapError(toWorkspaceError("remove", name, "prod", `Unable to check ${path}.`)),
      )

      if (!exists) {
        return
      }

      yield* this.git.removeWorktree(repoPath, path).pipe(
        Effect.mapError((gitErr) =>
          new WorkspaceError(
            "remove",
            name,
            "prod",
            `Git worktree removal failed: ${gitErr.message}`,
            gitErr.hint,
          ),
        ),
      )
    })
  }

  private renameProdVersion(
    name: string,
    fromVersion: string,
    toVersion: string,
  ): Effect.Effect<string, WorkspaceError> {
    return Effect.gen(this, function* () {
      const repoPath = yield* this.registry.resolve(name).pipe(
        Effect.mapError((cause) =>
          new WorkspaceError(
            "create",
            name,
            "prod",
            causeMessage(cause),
            "Register the project first with `rig init`.",
          ),
        ),
      )

      const currentPath = workspacePath(name, "prod", fromVersion)
      const nextPath = workspacePath(name, "prod", toVersion)

      const currentExists = yield* this.fs.exists(currentPath).pipe(
        Effect.mapError(toWorkspaceError("resolve", name, "prod", `Unable to check ${currentPath}.`)),
      )
      if (!currentExists) {
        return yield* Effect.fail(
          new WorkspaceError(
            "resolve",
            name,
            "prod",
            `No deployed prod workspace found for version '${fromVersion}'.`,
            `Deploy version ${fromVersion} first or choose an existing prod version.`,
          ),
        )
      }

      const nextExists = yield* this.fs.exists(nextPath).pipe(
        Effect.mapError(toWorkspaceError("resolve", name, "prod", `Unable to check ${nextPath}.`)),
      )
      if (nextExists) {
        return yield* Effect.fail(
          new WorkspaceError(
            "create",
            name,
            "prod",
            `Workspace already exists at ${nextPath}.`,
            `Version ${toVersion} is already deployed. Choose a different version.`,
          ),
        )
      }

      const activePath = yield* Effect.tryPromise({
        try: () => readlink(currentSymlink(name)),
        catch: () => null as unknown,
      }).pipe(Effect.catchAll(() => Effect.succeed(null as string | null)))

      yield* this.git.moveWorktree(repoPath, currentPath, nextPath).pipe(
        Effect.mapError((gitErr) =>
          new WorkspaceError(
            "create",
            name,
            "prod",
            `Git worktree move failed: ${gitErr.message}`,
            gitErr.hint,
          ),
        ),
      )

      if (activePath === currentPath) {
        yield* this.fs.symlink(nextPath, currentSymlink(name)).pipe(
          Effect.mapError(
            toWorkspaceError("create", name, "prod", "Unable to update current symlink."),
          ),
        )
      }

      return nextPath
    })
  }
}

// ── Layer ────────────────────────────────────────────────────────────────────

export const GitWorktreeWorkspaceLive = Layer.effect(
  Workspace,
  Effect.gen(function* () {
    const git = yield* Git
    const fs = yield* FileSystem
    const registry = yield* Registry
    return new GitWorktreeWorkspace(git, fs, registry)
  }),
)
