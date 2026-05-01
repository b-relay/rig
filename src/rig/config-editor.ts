import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"

import { decodeRigProjectConfig, type RigProjectConfig } from "./config.js"
import {
  platformMakeDirectory,
  platformReadFileString,
  platformRename,
  platformWriteFileString,
} from "./effect-platform.js"
import { RigRuntimeError } from "./errors.js"

export type RigConfigPatchPath = readonly [string, ...string[]]

export interface RigConfigSetPatch {
  readonly op: "set"
  readonly path: RigConfigPatchPath
  readonly value: unknown
}

export interface RigConfigRemovePatch {
  readonly op: "remove"
  readonly path: RigConfigPatchPath
}

export type RigConfigPatchOperation = RigConfigSetPatch | RigConfigRemovePatch

export interface RigConfigFieldDoc {
  readonly path: readonly string[]
  readonly description: string
  readonly valueShape: string
}

export interface RigConfigReadInput {
  readonly project: string
  readonly configPath: string
}

export interface RigConfigReadModel {
  readonly project: string
  readonly configPath: string
  readonly revision: string
  readonly raw: unknown
  readonly config: RigProjectConfig
  readonly fields: readonly RigConfigFieldDoc[]
}

export interface RigConfigPreviewInput {
  readonly project: string
  readonly configPath: string
  readonly expectedRevision: string
  readonly patch: readonly RigConfigPatchOperation[]
}

export interface RigConfigDiffEntry {
  readonly path: readonly string[]
  readonly before?: unknown
  readonly after?: unknown
  readonly description?: string
}

export interface RigConfigPreviewResult {
  readonly project: string
  readonly configPath: string
  readonly baseRevision: string
  readonly nextRevision: string
  readonly patch: readonly RigConfigPatchOperation[]
  readonly diff: readonly RigConfigDiffEntry[]
  readonly raw: unknown
  readonly config: RigProjectConfig
}

export interface RigConfigApplyResult extends RigConfigPreviewResult {
  readonly applied: true
  readonly backupPath: string
}

export interface RigConfigFileSnapshot {
  readonly path: string
  readonly raw: string
}

export interface RigConfigWriteInput {
  readonly path: string
  readonly previousRaw: string
  readonly nextRaw: string
  readonly revision: string
}

export interface RigConfigWriteResult {
  readonly backupPath: string
}

export interface RigConfigFileStoreService {
  readonly read: (path: string) => Effect.Effect<RigConfigFileSnapshot, RigRuntimeError>
  readonly writeAtomic: (input: RigConfigWriteInput) => Effect.Effect<RigConfigWriteResult, RigRuntimeError>
}

export interface RigConfigEditorService {
  readonly read: (input: RigConfigReadInput) => Effect.Effect<RigConfigReadModel, RigRuntimeError>
  readonly preview: (input: RigConfigPreviewInput) => Effect.Effect<RigConfigPreviewResult, RigRuntimeError>
  readonly apply: (input: RigConfigPreviewInput) => Effect.Effect<RigConfigApplyResult, RigRuntimeError>
}

export const RigConfigFileStore =
  Context.Service<RigConfigFileStoreService>("rig/rig/RigConfigFileStore")

export const RigConfigEditor =
  Context.Service<RigConfigEditorService>("rig/rig/RigConfigEditor")

const runtimeError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new RigRuntimeError(
    message,
    hint,
    {
      cause: cause instanceof Error ? cause.message : String(cause),
      ...(details ?? {}),
    },
  )

const revisionFor = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex")

const parseJson = (raw: string, configPath: string): Effect.Effect<unknown, RigRuntimeError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: runtimeError(
      "Unable to parse rig project config.",
      "Fix JSON syntax in rig.json before editing it through the control plane.",
      {
        reason: "invalid-config-json",
        configPath,
      },
    ),
  })

const validateProject = (
  project: string,
  configPath: string,
  raw: unknown,
): Effect.Effect<RigProjectConfig, RigRuntimeError> =>
  decodeRigProjectConfig(raw).pipe(
    Effect.mapError((error) =>
      new RigRuntimeError(
        "Unable to validate rig project config.",
        "Fix rig.json so it matches the rig Effect Schema before editing it through the control plane.",
        {
          reason: "invalid-config-schema",
          project,
          configPath,
          cause: error.message,
          details: error.details,
        },
      ),
    ),
    Effect.flatMap((config) => {
      if (config.name === project) {
        return Effect.succeed(config)
      }

      return Effect.fail(
        new RigRuntimeError(
          `Config project '${config.name}' does not match requested project '${project}'.`,
          "Reload the selected project before editing its config.",
          {
            reason: "project-mismatch",
            project,
            configProject: config.name,
            configPath,
          },
        ),
      )
    }),
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const cloneJson = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown

const getPath = (value: unknown, path: readonly string[]): unknown => {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

const assertSafePath = (
  path: readonly string[],
  configPath: string,
): Effect.Effect<void, RigRuntimeError> => {
  if (path.length === 0 || path.some((segment) => segment.trim().length === 0)) {
    return Effect.fail(
      new RigRuntimeError(
        "Config patch paths must contain at least one non-empty segment.",
        "Send structured patch paths such as ['components', 'web', 'port'].",
        { reason: "invalid-config-patch-path", configPath, path },
      ),
    )
  }

  if (path.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    return Effect.fail(
      new RigRuntimeError(
        "Config patch path contains an unsafe segment.",
        "Remove prototype-related path segments before retrying the config edit.",
        { reason: "unsafe-config-patch-path", configPath, path },
      ),
    )
  }

  return Effect.void
}

const setPath = (
  root: unknown,
  path: readonly string[],
  value: unknown,
  configPath: string,
): Effect.Effect<void, RigRuntimeError> =>
  Effect.gen(function* () {
    yield* assertSafePath(path, configPath)
    if (!isRecord(root)) {
      return yield* Effect.fail(
        new RigRuntimeError(
          "Config patch root must be a JSON object.",
          "Fix rig.json before applying structured config edits.",
          { reason: "invalid-config-root", configPath },
        ),
      )
    }

    let current: Record<string, unknown> = root
    for (const segment of path.slice(0, -1)) {
      const existing = current[segment]
      if (existing === undefined) {
        current[segment] = {}
      } else if (!isRecord(existing)) {
        return yield* Effect.fail(
          new RigRuntimeError(
            "Config patch cannot descend through a non-object value.",
            "Adjust the structured patch path so parent fields are JSON objects.",
            { reason: "invalid-config-patch-parent", configPath, path, segment },
          ),
        )
      }
      current = current[segment] as Record<string, unknown>
    }

    current[path[path.length - 1] as string] = value
  })

const removePath = (
  root: unknown,
  path: readonly string[],
  configPath: string,
): Effect.Effect<void, RigRuntimeError> =>
  Effect.gen(function* () {
    yield* assertSafePath(path, configPath)
    let current = root
    for (const segment of path.slice(0, -1)) {
      if (!isRecord(current)) {
        return
      }
      current = current[segment]
    }
    if (isRecord(current)) {
      delete current[path[path.length - 1] as string]
    }
  })

const docForPath = (path: readonly string[]): RigConfigFieldDoc | undefined =>
  editableFields.find((field) => {
    if (field.path.length !== path.length) {
      return false
    }
    return field.path.every((segment, index) => segment === "*" || segment === path[index])
  })

const applyPatch = (
  raw: unknown,
  configPath: string,
  patch: readonly RigConfigPatchOperation[],
): Effect.Effect<{ readonly next: unknown; readonly diff: readonly RigConfigDiffEntry[] }, RigRuntimeError> =>
  Effect.gen(function* () {
    const next = cloneJson(raw)
    const diff: RigConfigDiffEntry[] = []

    for (const operation of patch) {
      const before = getPath(next, operation.path)
      if (operation.op === "set") {
        if (operation.value === undefined) {
          return yield* Effect.fail(
            new RigRuntimeError(
              "Config patch set operation requires a JSON value.",
              "Use a remove operation instead of setting a field to undefined.",
              { reason: "invalid-config-patch-value", configPath, path: operation.path },
            ),
          )
        }
        yield* setPath(next, operation.path, cloneJson(operation.value), configPath)
      } else {
        yield* removePath(next, operation.path, configPath)
      }
      const after = getPath(next, operation.path)
      const doc = docForPath(operation.path)
      diff.push({
        path: operation.path,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(doc ? { description: doc.description } : {}),
      })
    }

    return { next, diff }
  })

const stableStringify = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`

const editableFields: readonly RigConfigFieldDoc[] = [
  { path: ["name"], valueShape: "string", description: "Stable registered project name." },
  { path: ["description"], valueShape: "string", description: "Human-readable project description." },
  { path: ["domain"], valueShape: "string", description: "Base domain used by live and generated deployment lanes." },
  { path: ["hooks", "preStart"], valueShape: "string", description: "Command to run before any component starts." },
  { path: ["hooks", "postStart"], valueShape: "string", description: "Command to run after all components are healthy." },
  { path: ["hooks", "preStop"], valueShape: "string", description: "Command to run before stopping project components." },
  { path: ["hooks", "postStop"], valueShape: "string", description: "Command to run after all project components are stopped." },
  { path: ["components", "*", "mode"], valueShape: "managed | installed", description: "Component runtime mode." },
  { path: ["components", "*", "uses"], valueShape: "sqlite | postgres | convex", description: "Bundled component plugin source." },
  { path: ["components", "*", "command"], valueShape: "string", description: "Command used to start a managed component." },
  { path: ["components", "*", "port"], valueShape: "number", description: "Optional concrete port required by a managed component." },
  { path: ["components", "*", "sitePort"], valueShape: "number", description: "Optional Convex Local site proxy port." },
  { path: ["components", "*", "health"], valueShape: "string", description: "Optional health check used for readiness and status." },
  { path: ["components", "*", "readyTimeout"], valueShape: "number", description: "Optional readiness timeout in seconds." },
  { path: ["components", "*", "dependsOn"], valueShape: "string[]", description: "Managed components that must start first." },
  { path: ["components", "*", "entrypoint"], valueShape: "string", description: "Executable entrypoint or source file for installation." },
  { path: ["components", "*", "build"], valueShape: "string", description: "Optional build command for an installed artifact." },
  { path: ["components", "*", "installName"], valueShape: "string", description: "Optional executable name for installation." },
  { path: ["components", "*", "path"], valueShape: "string", description: "Optional SQLite database file path." },
  { path: ["components", "*", "env"], valueShape: "Record<string,string>", description: "Inline environment variables for a component." },
  { path: ["components", "*", "envFile"], valueShape: "string", description: "Env file applied to a component." },
  { path: ["components", "*", "hooks"], valueShape: "hooks", description: "Lifecycle hooks applied to a component." },
  { path: ["local", "components"], valueShape: "Record<component, override>", description: "Working-copy lane component overrides." },
  { path: ["live", "components"], valueShape: "Record<component, override>", description: "Stable built lane component overrides." },
  { path: ["deployments", "components"], valueShape: "Record<component, override>", description: "Generated deployment component overrides." },
  { path: ["local", "env"], valueShape: "Record<string,string>", description: "Working-copy lane environment variables." },
  { path: ["live", "env"], valueShape: "Record<string,string>", description: "Live lane environment variables." },
  { path: ["deployments", "env"], valueShape: "Record<string,string>", description: "Generated deployment environment variables." },
  { path: ["local", "envFile"], valueShape: "string", description: "Working-copy lane env file." },
  { path: ["live", "envFile"], valueShape: "string", description: "Live lane env file." },
  { path: ["deployments", "envFile"], valueShape: "string", description: "Generated deployment env file." },
  { path: ["local", "proxy"], valueShape: "{ upstream: component }", description: "Working-copy lane reverse proxy settings." },
  { path: ["live", "proxy"], valueShape: "{ upstream: component }", description: "Live lane reverse proxy settings." },
  { path: ["deployments", "proxy"], valueShape: "{ upstream: component }", description: "Generated deployment reverse proxy settings." },
  { path: ["local", "daemon"], valueShape: "{ enabled?: boolean, keepAlive?: boolean }", description: "Working-copy lane daemon settings." },
  { path: ["live", "daemon"], valueShape: "{ enabled?: boolean, keepAlive?: boolean }", description: "Live lane daemon settings." },
  { path: ["deployments", "daemon"], valueShape: "{ enabled?: boolean, keepAlive?: boolean }", description: "Generated deployment daemon settings." },
  { path: ["local", "providers"], valueShape: "{ processSupervisor?: string }", description: "Working-copy lane provider selections." },
  { path: ["live", "providers"], valueShape: "{ processSupervisor?: string }", description: "Live lane provider selections." },
  { path: ["deployments", "providers"], valueShape: "{ processSupervisor?: string }", description: "Generated deployment provider selections." },
  { path: ["local", "providers", "processSupervisor"], valueShape: "string", description: "Working-copy lane process supervisor provider id." },
  { path: ["live", "providers", "processSupervisor"], valueShape: "string", description: "Live lane process supervisor provider id." },
  { path: ["deployments", "providers", "processSupervisor"], valueShape: "string", description: "Generated deployment process supervisor provider id." },
  { path: ["local", "domain"], valueShape: "string", description: "Working-copy lane domain override." },
  { path: ["live", "domain"], valueShape: "string", description: "Live lane domain override." },
  { path: ["deployments", "domain"], valueShape: "string", description: "Generated deployment domain override." },
  { path: ["local", "subdomain"], valueShape: "string", description: "Working-copy lane subdomain override." },
  { path: ["live", "subdomain"], valueShape: "string", description: "Live lane subdomain override." },
  { path: ["deployments", "subdomain"], valueShape: "string", description: "Generated deployment subdomain override." },
  { path: ["local", "deployBranch"], valueShape: "string", description: "Working-copy lane deploy branch." },
  { path: ["live", "deployBranch"], valueShape: "string", description: "Live lane deploy branch." },
  { path: ["deployments", "deployBranch"], valueShape: "string", description: "Generated deployment deploy branch." },
  { path: ["local", "providerProfile"], valueShape: "default | stub", description: "Working-copy lane provider profile." },
  { path: ["live", "providerProfile"], valueShape: "default | stub", description: "Live lane provider profile." },
  { path: ["deployments", "providerProfile"], valueShape: "default | stub", description: "Generated deployment provider profile." },
]

export const RigConfigFileStoreLive = Layer.succeed(RigConfigFileStore, {
  read: (path) =>
    Effect.gen(function* () {
      return {
        path,
        raw: yield* platformReadFileString(path),
      }
    }).pipe(
      Effect.mapError(runtimeError(
        "Unable to read rig project config.",
        "Ensure rig.json exists and is readable before editing it through the control plane.",
        { configPath: path },
      )),
    ),
  writeAtomic: (input) => {
    const backupPath = `${input.path}.backup-${input.revision.slice(0, 12)}.json`
    const tempPath = `${input.path}.tmp-${input.revision.slice(0, 12)}`
    return Effect.gen(function* () {
        yield* platformMakeDirectory(dirname(input.path))
        yield* platformWriteFileString(backupPath, input.previousRaw)
        yield* platformWriteFileString(tempPath, input.nextRaw)
        yield* platformRename(tempPath, input.path)
        return { backupPath }
      }).pipe(
        Effect.mapError(runtimeError(
        "Unable to atomically write rig project config.",
        "Use the reported backup path or retry after fixing filesystem permissions.",
        { configPath: input.path, backupPath, tempPath },
        )),
      )
  },
} satisfies RigConfigFileStoreService)

export const RigConfigEditorLive = Layer.effect(
  RigConfigEditor,
  Effect.gen(function* () {
    const store = yield* RigConfigFileStore
    const readCurrent = (input: RigConfigReadInput) =>
      Effect.gen(function* () {
        const file = yield* store.read(input.configPath)
        const parsed = yield* parseJson(file.raw, input.configPath)
        const config = yield* validateProject(input.project, input.configPath, parsed)
        const revision = revisionFor(file.raw)

        return {
          file,
          project: input.project,
          configPath: input.configPath,
          revision,
          raw: parsed,
          config,
          fields: editableFields,
        }
      })

    const readConfig = (input: RigConfigReadInput): Effect.Effect<RigConfigReadModel, RigRuntimeError> =>
      Effect.map(readCurrent(input), ({ file: _file, ...model }) => model)

    const previewFromCurrent = (
      current: RigConfigReadModel,
      input: RigConfigPreviewInput,
    ): Effect.Effect<RigConfigPreviewResult, RigRuntimeError> =>
      Effect.gen(function* () {
        if (current.revision !== input.expectedRevision) {
          return yield* Effect.fail(
            new RigRuntimeError(
              "Config edit is based on a stale revision.",
              "Reload the latest config and reapply the structured patch.",
              {
                reason: "stale-config-revision",
                project: input.project,
                configPath: input.configPath,
                expectedRevision: input.expectedRevision,
                currentRevision: current.revision,
              },
            ),
          )
        }

        const patched = yield* applyPatch(current.raw, input.configPath, input.patch)
        const config = yield* validateProject(input.project, input.configPath, patched.next)
        const nextRaw = stableStringify(patched.next)

        return {
          project: input.project,
          configPath: input.configPath,
          baseRevision: current.revision,
          nextRevision: revisionFor(nextRaw),
          patch: input.patch,
          diff: patched.diff,
          raw: patched.next,
          config,
        }
      })

    const previewConfig = (input: RigConfigPreviewInput): Effect.Effect<RigConfigPreviewResult, RigRuntimeError> =>
      Effect.gen(function* () {
        const current = yield* readConfig(input)
        return yield* previewFromCurrent(current, input)
      })

    return {
      read: readConfig,
      preview: previewConfig,
      apply: (input) =>
        Effect.gen(function* () {
          const current = yield* readCurrent(input)
          const preview = yield* previewFromCurrent(current, input)
          const write = yield* store.writeAtomic({
            path: input.configPath,
            previousRaw: current.file.raw,
            nextRaw: stableStringify(preview.raw),
            revision: current.revision,
          })
          return {
            ...preview,
            applied: true,
            backupPath: write.backupPath,
          }
        }),
    } satisfies RigConfigEditorService
  }),
)
