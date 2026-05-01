import { join } from "node:path"
import { Context, Effect, Layer } from "effect"

import {
  resolveRigLane,
  type ResolvedRigLane,
  type RigProjectConfig,
} from "./config.js"
import {
  isPlatformNotFound,
  platformMakeDirectory,
  platformReadFileString,
  platformRemove,
  platformWriteFileString,
} from "./effect-platform.js"
import { RigRuntimeError } from "./errors.js"

export type RigDeploymentKind = "local" | "live" | "generated"

export interface RigDeploymentRecord {
  readonly project: string
  readonly kind: RigDeploymentKind
  readonly name: string
  readonly sourceRef?: string
  readonly branchSlug: string
  readonly subdomain: string
  readonly workspacePath: string
  readonly dataRoot: string
  readonly logRoot: string
  readonly runtimeRoot: string
  readonly runtimeStatePath: string
  readonly assignedPorts: Readonly<Record<string, number>>
  readonly providerProfile: "default" | "stub"
  readonly resolved: ResolvedRigLane
}

export interface RigMaterializeGeneratedInput {
  readonly config: RigProjectConfig
  readonly stateRoot: string
  readonly branch?: string
  readonly name?: string
  readonly subdomain?: string
  readonly assignedPorts?: Readonly<Record<string, number>>
}

export interface RigListDeploymentsInput {
  readonly config: RigProjectConfig
  readonly stateRoot: string
}

export interface RigDestroyGeneratedInput {
  readonly config: RigProjectConfig
  readonly stateRoot: string
  readonly name: string
}

export interface RigRestoreGeneratedInput {
  readonly config: RigProjectConfig
  readonly stateRoot: string
  readonly record: RigDeploymentRecord
}

export interface RigDeploymentStoreService {
  readonly read: (
    project: string,
    stateRoot: string,
  ) => Effect.Effect<readonly RigDeploymentRecord[], RigRuntimeError>
  readonly write: (
    project: string,
    stateRoot: string,
    records: readonly RigDeploymentRecord[],
  ) => Effect.Effect<void, RigRuntimeError>
  readonly ensureState: (record: RigDeploymentRecord) => Effect.Effect<void, RigRuntimeError>
  readonly removeState: (record: RigDeploymentRecord) => Effect.Effect<void, RigRuntimeError>
}

export interface RigDeploymentManagerService {
  readonly previewGenerated: (
    input: RigMaterializeGeneratedInput,
  ) => Effect.Effect<RigDeploymentRecord, RigRuntimeError>
  readonly materializeGenerated: (
    input: RigMaterializeGeneratedInput,
  ) => Effect.Effect<RigDeploymentRecord, RigRuntimeError>
  readonly list: (
    input: RigListDeploymentsInput,
  ) => Effect.Effect<readonly RigDeploymentRecord[], RigRuntimeError>
  readonly resolveGenerated: (
    input: RigDestroyGeneratedInput,
  ) => Effect.Effect<RigDeploymentRecord, RigRuntimeError>
  readonly restoreGenerated: (
    input: RigRestoreGeneratedInput,
  ) => Effect.Effect<RigDeploymentRecord, RigRuntimeError>
  readonly destroyGenerated: (
    input: RigDestroyGeneratedInput,
  ) => Effect.Effect<RigDeploymentRecord, RigRuntimeError>
}

export const RigDeploymentStore =
  Context.Service<RigDeploymentStoreService>("rig/rig/RigDeploymentStore")

export const RigDeploymentManager =
  Context.Service<RigDeploymentManagerService>("rig/rig/RigDeploymentManager")

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

const shortHash = (value: string): string =>
  hashNumber(value).toString(36).slice(0, 6)

const portAssignmentNames = (config: RigProjectConfig): readonly string[] =>
  Object.entries(config.components).flatMap(([name, component]) => {
    if ("mode" in component && component.mode === "managed") {
      return [name]
    }
    if ("uses" in component && component.uses === "convex") {
      return [name, `${name}.site`]
    }
    if ("uses" in component && component.uses === "postgres") {
      return [name]
    }
    return []
  })

const assignPorts = (
  config: RigProjectConfig,
  deploymentName: string,
  explicit: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> => {
  const assigned: Record<string, number> = {}
  const used = new Set<number>()

  for (const name of portAssignmentNames(config)) {
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

const resolvedManagedPorts = (
  resolved: ResolvedRigLane,
  assignedPorts: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> => {
  const managedPorts = Object.fromEntries(
    resolved.runtimePlan.components.flatMap((component) =>
      component.kind === "managed" ? [[component.name, component.port] as const] : []
    ),
  )
  return {
    ...assignedPorts,
    ...managedPorts,
  }
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
  config: RigProjectConfig,
  stateRoot: string,
  kind: "local" | "live",
): Effect.Effect<RigDeploymentRecord, RigRuntimeError> => {
  const assignedPorts = assignPorts(config, kind, undefined)

  return resolveRigLane(config, {
    lane: kind,
    workspacePath: join(stateRoot, "workspaces", config.name, kind),
    dataRoot: join(stateRoot, "data", config.name, kind),
    deploymentName: kind,
    branchSlug: kind,
    subdomain: kind,
    assignedPorts,
  }).pipe(
    Effect.mapError((error) =>
      new RigRuntimeError(
        `Unable to resolve ${kind} deployment inventory for '${config.name}'.`,
        "Fix the rig project config before listing deployment inventory.",
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
        assignedPorts: resolvedManagedPorts(resolved, assignedPorts),
        providerProfile: resolved.providerProfile,
        resolved,
      } satisfies RigDeploymentRecord
    }),
  )
}

const generatedRecord = (
  input: RigMaterializeGeneratedInput,
  identity: {
    readonly name: string
    readonly sourceRef?: string
    readonly subdomain?: string
  },
): Effect.Effect<RigDeploymentRecord, RigRuntimeError> => {
  const rawIdentity = input.name ?? input.branch
  if (!rawIdentity) {
    return Effect.fail(
      new RigRuntimeError(
        "Generated deployment requires a branch or deployment name.",
        "Pass a branch ref or explicit deployment name before materializing a generated deployment.",
      ),
    )
  }

  const name = identity.name
  const slug = branchSlug(input.branch ?? name)
  const paths = generatedPaths(input.stateRoot, input.config.name, name)
  const assignedPorts = assignPorts(input.config, name, input.assignedPorts)

  return resolveRigLane(input.config, {
    lane: "deployment",
    workspacePath: paths.workspacePath,
    dataRoot: paths.dataRoot,
    deploymentName: name,
    branchSlug: slug,
    subdomain: identity.subdomain ?? input.subdomain,
    assignedPorts,
  }).pipe(
    Effect.mapError((error) =>
      new RigRuntimeError(
        `Unable to materialize generated deployment '${name}'.`,
        "Fix the deployments template or assigned port map and retry.",
        { cause: error.message, details: error.details },
      ),
    ),
    Effect.map((resolved) => ({
      project: input.config.name,
      kind: "generated",
      name,
      ...(identity.sourceRef ? { sourceRef: identity.sourceRef } : {}),
      branchSlug: slug,
      subdomain: resolved.subdomain,
      ...paths,
      assignedPorts: resolvedManagedPorts(resolved, assignedPorts),
      providerProfile: resolved.providerProfile,
      resolved,
    })),
  )
}

const generatedIdentity = (
  input: RigMaterializeGeneratedInput,
  existing: readonly RigDeploymentRecord[],
) => {
  if (input.name) {
    return {
      name: branchSlug(input.name),
      ...(input.subdomain ? { subdomain: input.subdomain } : {}),
    }
  }

  const sourceRef = input.branch
  if (!sourceRef) {
    return {
      name: "deployment",
      ...(input.subdomain ? { subdomain: input.subdomain } : {}),
    }
  }

  const baseName = branchSlug(sourceRef)
  const branch = branchSlug(sourceRef)
  const baseRecord = existing.find((entry) => entry.kind === "generated" && entry.name === baseName)
  if (!baseRecord || baseRecord.sourceRef === sourceRef || (!baseRecord.sourceRef && baseRecord.branchSlug === branch)) {
    return {
      name: baseName,
      sourceRef,
      ...(input.subdomain ? { subdomain: input.subdomain } : {}),
    }
  }

  let name = `${baseName}-${shortHash(sourceRef)}`
  for (let attempt = 1; existing.some((entry) =>
    entry.kind === "generated" &&
    entry.name === name &&
    entry.sourceRef !== sourceRef
  ); attempt += 1) {
    name = `${baseName}-${shortHash(`${sourceRef}:${attempt}`)}`
  }

  return {
    name,
    sourceRef,
    subdomain: input.subdomain ?? name,
  }
}

export const RigDeploymentManagerLive = Layer.effect(
  RigDeploymentManager,
  Effect.gen(function* () {
    const store = yield* RigDeploymentStore
    const resolveGenerated = (input: RigDestroyGeneratedInput) =>
      Effect.gen(function* () {
        const name = branchSlug(input.name)
        const existing = yield* store.read(input.config.name, input.stateRoot)
        const found = existing.find((entry) => entry.kind === "generated" && entry.name === name)
        if (!found) {
          return yield* Effect.fail(
            new RigRuntimeError(
              `Generated deployment '${name}' is not materialized.`,
              "List generated deployments and choose one that exists before destroying it.",
              { project: input.config.name, deployment: name, requestedDeployment: input.name },
            ),
          )
        }

        return found
      })

    return {
      previewGenerated: (input) =>
        Effect.gen(function* () {
          const existing = yield* store.read(input.config.name, input.stateRoot)
          return yield* generatedRecord(input, generatedIdentity(input, existing))
        }),
      materializeGenerated: (input) =>
        Effect.gen(function* () {
          const existing = yield* store.read(input.config.name, input.stateRoot)
          const record = yield* generatedRecord(input, generatedIdentity(input, existing))
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
      resolveGenerated,
      restoreGenerated: (input) =>
        Effect.gen(function* () {
          const existing = yield* store.read(input.config.name, input.stateRoot)
          const next = existing.some((entry) => entry.kind === "generated" && entry.name === input.record.name)
            ? existing.map((entry) =>
              entry.kind === "generated" && entry.name === input.record.name ? input.record : entry
            )
            : [...existing, input.record]

          yield* store.ensureState(input.record)
          yield* store.write(input.config.name, input.stateRoot, next)
          return input.record
        }),
      destroyGenerated: (input) =>
        Effect.gen(function* () {
          const found = yield* resolveGenerated(input)
          const existing = yield* store.read(input.config.name, input.stateRoot)
          yield* store.removeState(found)
          yield* store.write(
            input.config.name,
            input.stateRoot,
            existing.filter((entry) => !(entry.kind === "generated" && entry.name === found.name)),
          )
          return found
        }),
    } satisfies RigDeploymentManagerService
  }),
)

const deploymentInventoryPath = (stateRoot: string, project: string): string =>
  join(stateRoot, "runtime", project, "deployments.json")

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

export const RigFileDeploymentStoreLive = Layer.succeed(RigDeploymentStore, {
  read: (project, stateRoot) =>
    platformReadFileString(deploymentInventoryPath(stateRoot, project)).pipe(
      Effect.matchEffect({
        onSuccess: (raw) =>
          Effect.try({
            try: () => {
              const parsed = JSON.parse(raw) as unknown
              return Array.isArray(parsed) ? parsed as RigDeploymentRecord[] : []
            },
            catch: (cause) => cause,
          }),
        onFailure: (cause) => isPlatformNotFound(cause) ? Effect.succeed([]) : Effect.fail(cause),
      }),
      Effect.mapError(runtimeError(
        `Unable to read rig deployment inventory for '${project}'.`,
        "Ensure the rig state root is readable or repair the deployment inventory file.",
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
        `Unable to write rig deployment inventory for '${project}'.`,
        "Ensure the rig state root is writable and retry.",
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
        "Ensure the rig workspace, log, and runtime roots are writable.",
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
        "Ensure the rig workspace, log, and runtime roots are writable.",
        { project: record.project, deployment: record.name },
      )),
    ),
})
