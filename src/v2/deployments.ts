import { join } from "node:path"
import { Context, Effect, Layer } from "effect"

import {
  resolveV2Lane,
  type ResolvedV2Lane,
  type V2ProjectConfig,
} from "./config.js"
import {
  isPlatformNotFound,
  platformMakeDirectory,
  platformReadFileString,
  platformRemove,
  platformWriteFileString,
} from "./effect-platform.js"
import { V2RuntimeError } from "./errors.js"

export type V2DeploymentKind = "local" | "live" | "generated"

export interface V2DeploymentRecord {
  readonly project: string
  readonly kind: V2DeploymentKind
  readonly name: string
  readonly branchSlug: string
  readonly subdomain: string
  readonly workspacePath: string
  readonly dataRoot: string
  readonly logRoot: string
  readonly runtimeRoot: string
  readonly runtimeStatePath: string
  readonly assignedPorts: Readonly<Record<string, number>>
  readonly providerProfile: "default" | "stub"
  readonly resolved: ResolvedV2Lane
}

export interface V2MaterializeGeneratedInput {
  readonly config: V2ProjectConfig
  readonly stateRoot: string
  readonly branch?: string
  readonly name?: string
  readonly subdomain?: string
  readonly assignedPorts?: Readonly<Record<string, number>>
}

export interface V2ListDeploymentsInput {
  readonly config: V2ProjectConfig
  readonly stateRoot: string
}

export interface V2DestroyGeneratedInput {
  readonly config: V2ProjectConfig
  readonly stateRoot: string
  readonly name: string
}

export interface V2DeploymentStoreService {
  readonly read: (
    project: string,
    stateRoot: string,
  ) => Effect.Effect<readonly V2DeploymentRecord[], V2RuntimeError>
  readonly write: (
    project: string,
    stateRoot: string,
    records: readonly V2DeploymentRecord[],
  ) => Effect.Effect<void, V2RuntimeError>
  readonly ensureState: (record: V2DeploymentRecord) => Effect.Effect<void, V2RuntimeError>
  readonly removeState: (record: V2DeploymentRecord) => Effect.Effect<void, V2RuntimeError>
}

export interface V2DeploymentManagerService {
  readonly materializeGenerated: (
    input: V2MaterializeGeneratedInput,
  ) => Effect.Effect<V2DeploymentRecord, V2RuntimeError>
  readonly list: (
    input: V2ListDeploymentsInput,
  ) => Effect.Effect<readonly V2DeploymentRecord[], V2RuntimeError>
  readonly destroyGenerated: (
    input: V2DestroyGeneratedInput,
  ) => Effect.Effect<V2DeploymentRecord, V2RuntimeError>
}

export const V2DeploymentStore =
  Context.Service<V2DeploymentStoreService>("rig/v2/V2DeploymentStore")

export const V2DeploymentManager =
  Context.Service<V2DeploymentManagerService>("rig/v2/V2DeploymentManager")

export const branchSlug = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return normalized.length > 0 ? normalized : "deployment"
}

const hashNumber = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const managedComponentNames = (config: V2ProjectConfig): readonly string[] =>
  Object.entries(config.components)
    .filter(([, component]) =>
      ("mode" in component && component.mode === "managed") ||
      ("uses" in component && component.uses === "convex")
    )
    .map(([name]) => name)

const assignPorts = (
  config: V2ProjectConfig,
  deploymentName: string,
  explicit: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> => {
  const assigned: Record<string, number> = {}
  const used = new Set<number>()

  for (const name of managedComponentNames(config)) {
    const explicitPort = explicit?.[name]
    if (explicitPort !== undefined) {
      assigned[name] = explicitPort
      used.add(explicitPort)
      continue
    }

    let port = 42000 + (hashNumber(`${config.name}:${deploymentName}:${name}`) % 20000)
    while (used.has(port)) {
      port += 1
    }
    assigned[name] = port
    used.add(port)
  }

  return assigned
}

const generatedPaths = (
  stateRoot: string,
  project: string,
  name: string,
) => ({
  workspacePath: join(stateRoot, "workspaces", project, "deployments", name),
  dataRoot: join(stateRoot, "data", project, "deployments", name),
  logRoot: join(stateRoot, "logs", project, "deployments", name),
  runtimeRoot: join(stateRoot, "runtime", project, "deployments", name),
  runtimeStatePath: join(stateRoot, "runtime", project, "deployments", name, "runtime.json"),
})

const laneRecord = (
  config: V2ProjectConfig,
  stateRoot: string,
  kind: "local" | "live",
): Effect.Effect<V2DeploymentRecord, V2RuntimeError> =>
  resolveV2Lane(config, {
    lane: kind,
    workspacePath: join(stateRoot, "workspaces", config.name, kind),
    dataRoot: join(stateRoot, "data", config.name, kind),
    deploymentName: kind,
    branchSlug: kind,
    subdomain: kind,
    assignedPorts: assignPorts(config, kind, undefined),
  }).pipe(
    Effect.mapError((error) =>
      new V2RuntimeError(
        `Unable to resolve ${kind} deployment inventory for '${config.name}'.`,
        "Fix the v2 project config before listing deployment inventory.",
        { cause: error.message, details: error.details },
      ),
    ),
    Effect.map((resolved) => {
      return {
        project: config.name,
        kind,
        name: kind,
        branchSlug: kind,
        subdomain: kind,
        workspacePath: join(stateRoot, "workspaces", config.name, kind),
        dataRoot: join(stateRoot, "data", config.name, kind),
        logRoot: join(stateRoot, "logs", config.name, kind),
        runtimeRoot: join(stateRoot, "runtime", config.name, kind),
        runtimeStatePath: join(stateRoot, "runtime", config.name, kind, "runtime.json"),
        assignedPorts: assignPorts(config, kind, undefined),
        providerProfile: resolved.providerProfile,
        resolved,
      } satisfies V2DeploymentRecord
    }),
  )

const generatedRecord = (
  input: V2MaterializeGeneratedInput,
): Effect.Effect<V2DeploymentRecord, V2RuntimeError> => {
  const rawIdentity = input.name ?? input.branch
  if (!rawIdentity) {
    return Effect.fail(
      new V2RuntimeError(
        "Generated deployment requires a branch or deployment name.",
        "Pass a branch ref or explicit deployment name before materializing a generated deployment.",
      ),
    )
  }

  const name = input.name ? branchSlug(input.name) : branchSlug(input.branch as string)
  const slug = branchSlug(input.branch ?? name)
  const paths = generatedPaths(input.stateRoot, input.config.name, name)
  const assignedPorts = assignPorts(input.config, name, input.assignedPorts)

  return resolveV2Lane(input.config, {
    lane: "deployment",
    workspacePath: paths.workspacePath,
    dataRoot: paths.dataRoot,
    deploymentName: name,
    branchSlug: slug,
    subdomain: input.subdomain,
    assignedPorts,
  }).pipe(
    Effect.mapError((error) =>
      new V2RuntimeError(
        `Unable to materialize generated deployment '${name}'.`,
        "Fix the deployments template or assigned port map and retry.",
        { cause: error.message, details: error.details },
      ),
    ),
    Effect.map((resolved) => ({
      project: input.config.name,
      kind: "generated",
      name,
      branchSlug: slug,
      subdomain: resolved.subdomain,
      ...paths,
      assignedPorts,
      providerProfile: resolved.providerProfile,
      resolved,
    })),
  )
}

export const V2DeploymentManagerLive = Layer.effect(
  V2DeploymentManager,
  Effect.gen(function* () {
    const store = yield* V2DeploymentStore

    return {
      materializeGenerated: (input) =>
        Effect.gen(function* () {
          const record = yield* generatedRecord(input)
          const existing = yield* store.read(input.config.name, input.stateRoot)
          const next = existing.some((entry) => entry.kind === "generated" && entry.name === record.name)
            ? existing.map((entry) => entry.kind === "generated" && entry.name === record.name ? record : entry)
            : [...existing, record]

          yield* store.ensureState(record)
          yield* store.write(input.config.name, input.stateRoot, next)
          return record
        }),
      list: (input) =>
        Effect.gen(function* () {
          const local = yield* laneRecord(input.config, input.stateRoot, "local")
          const live = yield* laneRecord(input.config, input.stateRoot, "live")
          const generated = yield* store.read(input.config.name, input.stateRoot)
          return [local, live, ...generated]
        }),
      destroyGenerated: (input) =>
        Effect.gen(function* () {
          const existing = yield* store.read(input.config.name, input.stateRoot)
          const found = existing.find((entry) => entry.kind === "generated" && entry.name === input.name)
          if (!found) {
            return yield* Effect.fail(
              new V2RuntimeError(
                `Generated deployment '${input.name}' is not materialized.`,
                "List generated deployments and choose one that exists before destroying it.",
                { project: input.config.name, deployment: input.name },
              ),
            )
          }

          yield* store.removeState(found)
          yield* store.write(
            input.config.name,
            input.stateRoot,
            existing.filter((entry) => !(entry.kind === "generated" && entry.name === input.name)),
          )
          return found
        }),
    } satisfies V2DeploymentManagerService
  }),
)

const deploymentInventoryPath = (stateRoot: string, project: string): string =>
  join(stateRoot, "runtime", project, "deployments.json")

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

export const V2FileDeploymentStoreLive = Layer.succeed(V2DeploymentStore, {
  read: (project, stateRoot) =>
    platformReadFileString(deploymentInventoryPath(stateRoot, project)).pipe(
      Effect.matchEffect({
        onSuccess: (raw) =>
          Effect.try({
            try: () => {
              const parsed = JSON.parse(raw) as unknown
              return Array.isArray(parsed) ? parsed as V2DeploymentRecord[] : []
            },
            catch: (cause) => cause,
          }),
        onFailure: (cause) => isPlatformNotFound(cause) ? Effect.succeed([]) : Effect.fail(cause),
      }),
      Effect.mapError(runtimeError(
        `Unable to read v2 deployment inventory for '${project}'.`,
        "Ensure the v2 state root is readable or repair the deployment inventory file.",
        { project, stateRoot },
      )),
    ),
  write: (project, stateRoot, records) =>
    Effect.gen(function* () {
      const path = deploymentInventoryPath(stateRoot, project)
      yield* platformMakeDirectory(join(stateRoot, "runtime", project))
      yield* platformWriteFileString(path, `${JSON.stringify(records, null, 2)}\n`)
    }).pipe(
      Effect.mapError(runtimeError(
        `Unable to write v2 deployment inventory for '${project}'.`,
        "Ensure the v2 state root is writable and retry.",
        { project, stateRoot },
      )),
    ),
  ensureState: (record) =>
    Effect.gen(function* () {
      yield* platformMakeDirectory(record.workspacePath)
      yield* platformMakeDirectory(record.dataRoot)
      yield* platformMakeDirectory(record.logRoot)
      yield* platformMakeDirectory(record.runtimeRoot)
      yield* platformWriteFileString(record.runtimeStatePath, `${JSON.stringify(record, null, 2)}\n`)
    }).pipe(
      Effect.mapError(runtimeError(
        `Unable to materialize generated deployment state for '${record.name}'.`,
        "Ensure the v2 workspace, log, and runtime roots are writable.",
        { project: record.project, deployment: record.name },
      )),
    ),
  removeState: (record) =>
    Effect.gen(function* () {
      yield* platformRemove(record.workspacePath, { recursive: true, force: true })
      yield* platformRemove(record.dataRoot, { recursive: true, force: true })
      yield* platformRemove(record.logRoot, { recursive: true, force: true })
      yield* platformRemove(record.runtimeRoot, { recursive: true, force: true })
    }).pipe(
      Effect.mapError(runtimeError(
        `Unable to remove generated deployment state for '${record.name}'.`,
        "Ensure the v2 workspace, log, and runtime roots are writable.",
        { project: record.project, deployment: record.name },
      )),
    ),
})
