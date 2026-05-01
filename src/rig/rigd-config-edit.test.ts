import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import {
  RigConfigEditorLive,
  RigConfigFileStore,
  RigConfigFileStoreLive,
  type RigConfigFileStoreService,
} from "./config-editor.js"
import { RigDefaultControlPlaneLive } from "./control-plane.js"
import {
  RigDeploymentManagerLive,
  RigDeploymentStore,
  type RigDeploymentRecord,
  type RigDeploymentStoreService,
} from "./deployments.js"
import { RigProviderContractsLive } from "./provider-contracts.js"
import { RigdActionPreflightLive } from "./rigd-actions.js"
import { Rigd, RigdLive } from "./rigd.js"
import { RigFileRigdStateStoreLive } from "./rigd-state.js"
import { RigRuntimeExecutorLive } from "./runtime-executor.js"
import { RigLogger, RigRuntimeLive } from "./services.js"
import { RigRuntimeError } from "./errors.js"

class MemoryDeploymentStore implements RigDeploymentStoreService {
  readonly records = new Map<string, RigDeploymentRecord[]>()

  read(project: string, _stateRoot: string) {
    return Effect.succeed(this.records.get(project) ?? [])
  }

  write(project: string, _stateRoot: string, records: readonly RigDeploymentRecord[]) {
    this.records.set(project, [...records])
    return Effect.void
  }

  ensureState(_record: RigDeploymentRecord) {
    return Effect.void
  }

  removeState(_record: RigDeploymentRecord) {
    return Effect.void
  }
}

class CaptureRigLogger {
  info() {
    return Effect.void
  }

  error() {
    return Effect.void
  }
}

const rawConfig = () => ({
  name: "pantry",
  description: "Original description",
  domain: "${subdomain}.preview.b-relay.com",
  components: {
    web: {
      mode: "managed",
      command: "bun run start -- --port ${web.port}",
      port: 3070,
      health: "http://127.0.0.1:${web.port}/health",
    },
  },
  deployments: {
    subdomain: "${branchSlug}",
    providerProfile: "stub",
  },
})

const writeConfig = async (configPath: string, value: unknown = rawConfig()) => {
  await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

const runWithRigd = async <A>(effect: Effect.Effect<A, unknown, Rigd>) => {
  const logger = new CaptureRigLogger()
  const deploymentManagerLive = Layer.provide(
    RigDeploymentManagerLive,
    Layer.succeed(RigDeploymentStore, new MemoryDeploymentStore()),
  )
  const configStoreLive = RigConfigFileStoreLive
  const rigdDependencies = Layer.mergeAll(
    RigRuntimeLive,
    deploymentManagerLive,
    Layer.succeed(RigLogger, logger),
    RigProviderContractsLive("default"),
    RigFileRigdStateStoreLive,
    RigDefaultControlPlaneLive,
    RigdActionPreflightLive,
    Layer.provide(RigRuntimeExecutorLive, RigProviderContractsLive("default")),
    Layer.provide(RigConfigEditorLive, configStoreLive),
  )

  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          RigRuntimeLive,
          Layer.succeed(RigLogger, logger),
          deploymentManagerLive,
          RigProviderContractsLive("default"),
          RigFileRigdStateStoreLive,
          RigDefaultControlPlaneLive,
          RigdActionPreflightLive,
          Layer.provide(RigRuntimeExecutorLive, RigProviderContractsLive("default")),
          Layer.provide(RigConfigEditorLive, configStoreLive),
          Layer.provide(RigdLive, rigdDependencies),
        ),
      ),
    ),
  )
}

const runWithConfigStore = async <A>(
  effect: Effect.Effect<A, unknown, Rigd>,
  store: RigConfigFileStoreService,
) => {
  const logger = new CaptureRigLogger()
  const deploymentManagerLive = Layer.provide(
    RigDeploymentManagerLive,
    Layer.succeed(RigDeploymentStore, new MemoryDeploymentStore()),
  )
  const configStoreLive = Layer.succeed(RigConfigFileStore, store)
  const rigdDependencies = Layer.mergeAll(
    RigRuntimeLive,
    deploymentManagerLive,
    Layer.succeed(RigLogger, logger),
    RigProviderContractsLive("default"),
    RigFileRigdStateStoreLive,
    RigDefaultControlPlaneLive,
    RigdActionPreflightLive,
    Layer.provide(RigRuntimeExecutorLive, RigProviderContractsLive("default")),
    Layer.provide(RigConfigEditorLive, configStoreLive),
  )

  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          RigRuntimeLive,
          Layer.succeed(RigLogger, logger),
          deploymentManagerLive,
          RigProviderContractsLive("default"),
          RigFileRigdStateStoreLive,
          RigDefaultControlPlaneLive,
          RigdActionPreflightLive,
          Layer.provide(RigRuntimeExecutorLive, RigProviderContractsLive("default")),
          Layer.provide(RigConfigEditorLive, configStoreLive),
          Layer.provide(RigdLive, rigdDependencies),
        ),
      ),
    ),
  )
}

describe("GIVEN rigd config editing WHEN used by the control-plane boundary THEN edits are structured validated and recoverable", () => {
  test("GIVEN a rig.json WHEN config is read THEN editor-ready config, revision, and field docs are returned", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-config-edit-"))
    const configPath = join(root, "rig.json")

    try {
      await writeConfig(configPath)

      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          return yield* rigd.configRead({
            project: "pantry",
            configPath,
          })
        }),
      )

      expect(result).toMatchObject({
        project: "pantry",
        configPath,
        config: {
          name: "pantry",
          components: {
            web: {
              mode: "managed",
              port: 3070,
            },
          },
        },
      })
      expect(result.revision).toHaveLength(64)
      expect(result.raw).toEqual(rawConfig())
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          path: ["components", "*", "command"],
          description: expect.stringContaining("Command"),
        }),
      )
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          path: ["deployments", "providerProfile"],
          valueShape: "default | stub",
        }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN a structured config patch WHEN previewed THEN schema-validated diff is returned without writing rig.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-config-edit-"))
    const configPath = join(root, "rig.json")

    try {
      await writeConfig(configPath)
      const beforeRaw = await readFile(configPath, "utf8")

      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const current = yield* rigd.configRead({ project: "pantry", configPath })
          const preview = yield* rigd.configPreview({
            project: "pantry",
            configPath,
            expectedRevision: current.revision,
            patch: [
              {
                op: "set",
                path: ["description"],
                value: "Updated from the web editor",
              },
              {
                op: "set",
                path: ["components", "web", "port"],
                value: 4080,
              },
            ],
          })
          return { current, preview }
        }),
      )

      expect(result.preview).toMatchObject({
        project: "pantry",
        configPath,
        baseRevision: result.current.revision,
        config: {
          description: "Updated from the web editor",
          components: {
            web: {
              port: 4080,
            },
          },
        },
      })
      expect(result.preview.nextRevision).not.toBe(result.current.revision)
      expect(result.preview.diff).toContainEqual(
        expect.objectContaining({
          path: ["description"],
          before: "Original description",
          after: "Updated from the web editor",
          description: "Human-readable project description.",
        }),
      )
      expect(result.preview.diff).toContainEqual(
        expect.objectContaining({
          path: ["components", "web", "port"],
          before: 3070,
          after: 4080,
          description: "Optional concrete port required by a managed component.",
        }),
      )
      expect(await readFile(configPath, "utf8")).toBe(beforeRaw)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN a valid structured config patch WHEN applied THEN rig.json is atomically updated with a recoverable backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-config-edit-"))
    const configPath = join(root, "rig.json")

    try {
      await writeConfig(configPath)

      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const current = yield* rigd.configRead({ project: "pantry", configPath })
          return yield* rigd.configApply({
            project: "pantry",
            configPath,
            expectedRevision: current.revision,
            patch: [
              {
                op: "set",
                path: ["live", "deployBranch"],
                value: "main",
              },
              {
                op: "remove",
                path: ["description"],
              },
            ],
          })
        }),
      )

      const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>
      const backup = JSON.parse(await readFile(result.backupPath, "utf8")) as Record<string, unknown>

      expect(result.applied).toBe(true)
      expect(result.backupPath).toContain("rig.json.backup-")
      expect(result.diff).toContainEqual(
        expect.objectContaining({
          path: ["live", "deployBranch"],
          after: "main",
          description: "Live lane deploy branch.",
        }),
      )
      expect(result.diff).toContainEqual(
        expect.objectContaining({
          path: ["description"],
          before: "Original description",
        }),
      )
      expect(written.description).toBeUndefined()
      expect(written.live).toEqual({ deployBranch: "main" })
      expect(backup.description).toBe("Original description")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN an invalid structured config patch WHEN previewed THEN Effect Schema rejects it and rig.json is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-config-edit-"))
    const configPath = join(root, "rig.json")

    try {
      await writeConfig(configPath)
      const beforeRaw = await readFile(configPath, "utf8")

      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const current = yield* rigd.configRead({ project: "pantry", configPath })
          return yield* Effect.flip(
            rigd.configPreview({
              project: "pantry",
              configPath,
              expectedRevision: current.revision,
              patch: [
                {
                  op: "set",
                  path: ["components", "web", "command"],
                  value: "bun run start -- --host 0.0.0.0",
                },
              ],
            }),
          )
        }),
      )

      expect(result).toMatchObject({
        _tag: "RigRuntimeError",
        details: {
          reason: "invalid-config-schema",
          project: "pantry",
          configPath,
        },
      })
      expect(await readFile(configPath, "utf8")).toBe(beforeRaw)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN a stale expected revision WHEN apply is requested THEN rig.json is not written", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-config-edit-"))
    const configPath = join(root, "rig.json")

    try {
      await writeConfig(configPath)

      const result = await runWithRigd(
        Effect.gen(function* () {
          const rigd = yield* Rigd
          const current = yield* rigd.configRead({ project: "pantry", configPath })
          yield* Effect.promise(() =>
            writeConfig(configPath, {
              ...rawConfig(),
              description: "Changed by another editor",
            })
          )
          const error = yield* Effect.flip(
            rigd.configApply({
              project: "pantry",
              configPath,
              expectedRevision: current.revision,
              patch: [
                {
                  op: "set",
                  path: ["description"],
                  value: "Should not write",
                },
              ],
            }),
          )
          const after = yield* rigd.configRead({ project: "pantry", configPath })
          return { error, after }
        }),
      )

      expect(result.error).toMatchObject({
        _tag: "RigRuntimeError",
        details: {
          reason: "stale-config-revision",
          expectedRevision: expect.any(String),
          currentRevision: expect.any(String),
        },
      })
      expect(result.after.config.description).toBe("Changed by another editor")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN atomic write fails WHEN apply is requested THEN previous config remains recoverable", async () => {
    const configPath = "/virtual/rig.json"
    const originalRaw = `${JSON.stringify(rawConfig(), null, 2)}\n`
    let storedRaw = originalRaw
    let recoveryRaw = ""

    const failingStore: RigConfigFileStoreService = {
      read: (path) => Effect.succeed({ path, raw: storedRaw }),
      writeAtomic: (input) => {
        recoveryRaw = input.previousRaw
        return Effect.fail(
          new RigRuntimeError(
            "Unable to atomically write rig project config.",
            "Use the retained previous config contents to recover rig.json.",
            {
              reason: "config-write-failed",
              configPath: input.path,
              backupPath: `${input.path}.backup-test.json`,
            },
          ),
        )
      },
    }

    const result = await runWithConfigStore(
      Effect.gen(function* () {
        const rigd = yield* Rigd
        const current = yield* rigd.configRead({ project: "pantry", configPath })
        const error = yield* Effect.flip(
          rigd.configApply({
            project: "pantry",
            configPath,
            expectedRevision: current.revision,
            patch: [
              {
                op: "set",
                path: ["description"],
                value: "Should not persist",
              },
            ],
          }),
        )
        const after = yield* rigd.configRead({ project: "pantry", configPath })
        return { error, after }
      }),
      failingStore,
    )

    expect(result.error).toMatchObject({
      _tag: "RigRuntimeError",
      details: {
        reason: "config-write-failed",
        backupPath: "/virtual/rig.json.backup-test.json",
      },
    })
    expect(recoveryRaw).toBe(originalRaw)
    expect(storedRaw).toBe(originalRaw)
    expect(result.after.config.description).toBe("Original description")
  })
})
