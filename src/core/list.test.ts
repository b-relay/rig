import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runListCommand } from "./list.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  Registry,
  type Registry as RegistryService,
  type RegistryEntry,
} from "../interfaces/registry.js"
import {
  Workspace,
  type Workspace as WorkspaceService,
  type WorkspaceInfo,
} from "../interfaces/workspace.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import type { RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly tables: Array<readonly Record<string, unknown>[]> = []

  info(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  warn(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  error(_structured: RigError) {
    return Effect.void
  }

  success(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  table(rows: readonly Record<string, unknown>[]) {
    this.tables.push(rows)
    return Effect.void
  }
}

class StaticRegistry implements RegistryService {
  constructor(private readonly entries: readonly RegistryEntry[]) {}

  register(_name: string, _repoPath: string) {
    return Effect.void
  }

  unregister(_name: string) {
    return Effect.void
  }

  resolve(name: string) {
    const entry = this.entries.find((candidate) => candidate.name === name)
    return Effect.succeed(entry?.repoPath ?? "/tmp/missing")
  }

  list() {
    return Effect.succeed(this.entries)
  }
}

class StaticWorkspace implements WorkspaceService {
  constructor(private readonly rows: readonly WorkspaceInfo[]) {}

  create(_name: string, _env: "dev" | "prod", _version: string, _commitRef: string) {
    return Effect.succeed("/tmp/workspace")
  }

  resolve(_name: string, _env: "dev" | "prod", _version?: string) {
    return Effect.succeed("/tmp/workspace")
  }

  activate(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.succeed("/tmp/workspace")
  }

  removeVersion(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.void
  }

  renameVersion(_name: string, _env: "dev" | "prod", _fromVersion: string, _toVersion: string) {
    return Effect.succeed("/tmp/workspace")
  }

  sync(_name: string, _env: "dev" | "prod") {
    return Effect.void
  }

  list(name: string) {
    return Effect.succeed(this.rows.filter((row) => row.name === name))
  }
}

describe("GIVEN suite context WHEN list command executes THEN behavior is covered", () => {
  test("GIVEN registered projects WHEN list runs THEN it includes the current prod version or N/A", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-list-command-"))
    const pantryRepo = join(root, "pantry")
    const docsRepo = join(root, "docs")
    await mkdir(join(pantryRepo, ".rig", "versions"), { recursive: true })
    await mkdir(join(docsRepo, ".rig", "versions"), { recursive: true })
    await writeFile(
      join(pantryRepo, ".rig", "versions", "pantry.json"),
      `${JSON.stringify({
        name: "pantry",
        entries: [
          {
            action: "minor",
            oldVersion: "0.1.0",
            newVersion: "0.2.0",
            changedAt: "2026-03-09T00:00:00.000Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    )

    const logger = new CaptureLogger()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(
        Registry,
        new StaticRegistry([
          {
            name: "pantry",
            repoPath: pantryRepo,
            registeredAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          {
            name: "docs",
            repoPath: docsRepo,
            registeredAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ]),
      ),
      Layer.succeed(
        Workspace,
        new StaticWorkspace([
          {
            name: "pantry",
            env: "prod",
            version: "0.2.0",
            path: "/tmp/pantry-prod",
            active: true,
          },
        ]),
      ),
    )

    const exitCode = await Effect.runPromise(runListCommand().pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    expect(logger.tables).toEqual([
      [
        {
          name: "pantry",
          repoPath: pantryRepo,
          currentProdVersion: "0.2.0",
          registeredAt: "2026-01-01T00:00:00.000Z",
        },
        {
          name: "docs",
          repoPath: docsRepo,
          currentProdVersion: "N/A",
          registeredAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    ])

    await rm(root, { recursive: true, force: true })
  })
})
