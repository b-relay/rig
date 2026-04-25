import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect-v4"

import { decodeV2ProjectConfig, type V2ProjectConfig } from "./config.js"
import { V2RuntimeError } from "./errors.js"

export type V2ConfigPatchPath = readonly [string, ...string[]]

export interface V2ConfigSetPatch {
  readonly op: "set"
  readonly path: V2ConfigPatchPath
  readonly value: unknown
}

export interface V2ConfigRemovePatch {
  readonly op: "remove"
  readonly path: V2ConfigPatchPath
}

export type V2ConfigPatchOperation = V2ConfigSetPatch | V2ConfigRemovePatch

export interface V2ConfigFieldDoc {
  readonly path: readonly string[]
  readonly description: string
  readonly valueShape: string
}

export interface V2ConfigReadInput {
  readonly project: string
  readonly configPath: string
}

export interface V2ConfigReadModel {
  readonly project: string
  readonly configPath: string
  readonly revision: string
  readonly raw: unknown
  readonly config: V2ProjectConfig
  readonly fields: readonly V2ConfigFieldDoc[]
}

export interface V2ConfigPreviewInput {
  readonly project: string
  readonly configPath: string
  readonly expectedRevision: string
  readonly patch: readonly V2ConfigPatchOperation[]
}

export interface V2ConfigDiffEntry {
  readonly path: readonly string[]
  readonly before?: unknown
  readonly after?: unknown
  readonly description?: string
}

export interface V2ConfigPreviewResult {
  readonly project: string
  readonly configPath: string
  readonly baseRevision: string
  readonly nextRevision: string
  readonly patch: readonly V2ConfigPatchOperation[]
  readonly diff: readonly V2ConfigDiffEntry[]
  readonly raw: unknown
  readonly config: V2ProjectConfig
}

export interface V2ConfigApplyResult extends V2ConfigPreviewResult {
  readonly applied: true
  readonly backupPath: string
}

export interface V2ConfigFileSnapshot {
  readonly path: string
  readonly raw: string
}

export interface V2ConfigWriteInput {
  readonly path: string
  readonly previousRaw: string
  readonly nextRaw: string
  readonly revision: string
}

export interface V2ConfigWriteResult {
  readonly backupPath: string
}

export interface V2ConfigFileStoreService {
  readonly read: (path: string) => Effect.Effect<V2ConfigFileSnapshot, V2RuntimeError>
  readonly writeAtomic: (input: V2ConfigWriteInput) => Effect.Effect<V2ConfigWriteResult, V2RuntimeError>
}

export interface V2ConfigEditorService {
  readonly read: (input: V2ConfigReadInput) => Effect.Effect<V2ConfigReadModel, V2RuntimeError>
  readonly preview: (input: V2ConfigPreviewInput) => Effect.Effect<V2ConfigPreviewResult, V2RuntimeError>
  readonly apply: (input: V2ConfigPreviewInput) => Effect.Effect<V2ConfigApplyResult, V2RuntimeError>
}

export const V2ConfigFileStore =
  Context.Service<V2ConfigFileStoreService>("rig/v2/V2ConfigFileStore")

export const V2ConfigEditor =
  Context.Service<V2ConfigEditorService>("rig/v2/V2ConfigEditor")

const runtimeError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new V2RuntimeError(
    message,
    hint,
    {
      cause: cause instanceof Error ? cause.message : String(cause),
      ...(details ?? {}),
    },
  )

const revisionFor = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex")

const parseJson = (raw: string, configPath: string): Effect.Effect<unknown, V2RuntimeError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: runtimeError(
      "Unable to parse v2 project config.",
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
): Effect.Effect<V2ProjectConfig, V2RuntimeError> =>
  decodeV2ProjectConfig(raw).pipe(
    Effect.mapError((error) =>
      new V2RuntimeError(
        "Unable to validate v2 project config.",
        "Fix rig.json so it matches the v2 Effect Schema before editing it through the control plane.",
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
        new V2RuntimeError(
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
): Effect.Effect<void, V2RuntimeError> => {
  if (path.length === 0 || path.some((segment) => segment.trim().length === 0)) {
    return Effect.fail(
      new V2RuntimeError(
        "Config patch paths must contain at least one non-empty segment.",
        "Send structured patch paths such as ['components', 'web', 'port'].",
        { reason: "invalid-config-patch-path", configPath, path },
      ),
    )
  }

  if (path.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    return Effect.fail(
      new V2RuntimeError(
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
): Effect.Effect<void, V2RuntimeError> =>
  Effect.gen(function* () {
    yield* assertSafePath(path, configPath)
    if (!isRecord(root)) {
      return yield* Effect.fail(
        new V2RuntimeError(
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
          new V2RuntimeError(
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
): Effect.Effect<void, V2RuntimeError> =>
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

const docForPath = (path: readonly string[]): V2ConfigFieldDoc | undefined =>
  editableFields.find((field) => {
    if (field.path.length !== path.length) {
      return false
    }
    return field.path.every((segment, index) => segment === "*" || segment === path[index])
  })

const applyPatch = (
  raw: unknown,
  configPath: string,
  patch: readonly V2ConfigPatchOperation[],
): Effect.Effect<{ readonly next: unknown; readonly diff: readonly V2ConfigDiffEntry[] }, V2RuntimeError> =>
  Effect.gen(function* () {
    const next = cloneJson(raw)
    const diff: V2ConfigDiffEntry[] = []

    for (const operation of patch) {
      const before = getPath(next, operation.path)
      if (operation.op === "set") {
        if (operation.value === undefined) {
          return yield* Effect.fail(
            new V2RuntimeError(
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

const editableFields: readonly V2ConfigFieldDoc[] = [
  { path: ["name"], valueShape: "string", description: "Stable registered project name." },
  { path: ["description"], valueShape: "string", description: "Human-readable project description." },
  { path: ["domain"], valueShape: "string", description: "Base domain used by live and generated deployment lanes." },
  { path: ["hooks", "preStart"], valueShape: "string", description: "Command to run before any component starts." },
  { path: ["hooks", "postStart"], valueShape: "string", description: "Command to run after all components are healthy." },
  { path: ["hooks", "preStop"], valueShape: "string", description: "Command to run before stopping project components." },
  { path: ["hooks", "postStop"], valueShape: "string", description: "Command to run after all project components are stopped." },
  { path: ["components", "*", "mode"], valueShape: "managed | installed", description: "Component runtime mode." },
  { path: ["components", "*", "command"], valueShape: "string", description: "Command used to start a managed component." },
  { path: ["components", "*", "port"], valueShape: "number", description: "Optional concrete port required by a managed component." },
  { path: ["components", "*", "health"], valueShape: "string", description: "Optional health check used for readiness and status." },
  { path: ["components", "*", "readyTimeout"], valueShape: "number", description: "Optional readiness timeout in seconds." },
  { path: ["components", "*", "dependsOn"], valueShape: "string[]", description: "Managed components that must start first." },
  { path: ["components", "*", "entrypoint"], valueShape: "string", description: "Executable entrypoint or source file for installation." },
  { path: ["components", "*", "build"], valueShape: "string", description: "Optional build command for an installed artifact." },
  { path: ["components", "*", "installName"], valueShape: "string", description: "Optional executable name for installation." },
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

export const V2ConfigFileStoreLive = Layer.succeed(V2ConfigFileStore, {
  read: (path) =>
    Effect.tryPromise({
      try: async () => ({
        path,
        raw: await readFile(path, "utf8"),
      }),
      catch: runtimeError(
        "Unable to read v2 project config.",
        "Ensure rig.json exists and is readable before editing it through the control plane.",
        { configPath: path },
      ),
    }),
  writeAtomic: (input) => {
    const backupPath = `${input.path}.backup-${input.revision.slice(0, 12)}.json`
    const tempPath = `${input.path}.tmp-${input.revision.slice(0, 12)}`
    return Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(input.path), { recursive: true })
        await writeFile(backupPath, input.previousRaw, "utf8")
        await writeFile(tempPath, input.nextRaw, "utf8")
        await rename(tempPath, input.path)
        return { backupPath }
      },
      catch: runtimeError(
        "Unable to atomically write v2 project config.",
        "Use the reported backup path or retry after fixing filesystem permissions.",
        { configPath: input.path, backupPath, tempPath },
      ),
    })
  },
} satisfies V2ConfigFileStoreService)

export const V2ConfigEditorLive = Layer.effect(
  V2ConfigEditor,
  Effect.gen(function* () {
    const store = yield* V2ConfigFileStore
    const readCurrent = (input: V2ConfigReadInput) =>
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

    const readConfig = (input: V2ConfigReadInput): Effect.Effect<V2ConfigReadModel, V2RuntimeError> =>
      Effect.map(readCurrent(input), ({ file: _file, ...model }) => model)

    const previewFromCurrent = (
      current: V2ConfigReadModel,
      input: V2ConfigPreviewInput,
    ): Effect.Effect<V2ConfigPreviewResult, V2RuntimeError> =>
      Effect.gen(function* () {
        if (current.revision !== input.expectedRevision) {
          return yield* Effect.fail(
            new V2RuntimeError(
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

    const previewConfig = (input: V2ConfigPreviewInput): Effect.Effect<V2ConfigPreviewResult, V2RuntimeError> =>
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
    } satisfies V2ConfigEditorService
  }),
)
