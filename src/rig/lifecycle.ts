import { Context, Effect, Layer } from "effect"

import type { RigProjectConfig } from "./config.js"
import { branchSlug } from "./deployments.js"
import { Rigd, type RigdHealthState, type RigdLogEntry } from "./rigd.js"
import { RigLogger } from "./services.js"

export type RigLifecycleWriteAction = "up" | "down"
export type RigLifecycleAction = RigLifecycleWriteAction | "restart" | "logs" | "status"
export type RigLifecycleLane = "local" | "live"
export type RigLifecycleTarget =
  | { readonly kind: RigLifecycleLane }
  | { readonly kind: "generated"; readonly deploymentName: string }

export interface RigLifecycleRequest {
  readonly action: RigLifecycleAction
  readonly project: string
  readonly lane?: RigLifecycleLane
  readonly target?: RigLifecycleTarget
  readonly stateRoot: string
  readonly config?: RigProjectConfig
  readonly follow?: boolean
  readonly lines?: number
  readonly structured?: boolean
}

export interface RigLifecycleService {
  readonly run: (request: RigLifecycleRequest) => Effect.Effect<void>
}

export const RigLifecycle = Context.Service<RigLifecycleService>("rig/rig/RigLifecycle")

const lifecycleTarget = (request: RigLifecycleRequest): RigLifecycleTarget =>
  request.target ?? { kind: request.lane ?? "local" }

const lifecycleTargetLogScope = (target: RigLifecycleTarget) =>
  target.kind === "generated"
    ? { deployment: branchSlug(target.deploymentName) }
    : { lane: target.kind }

const lifecycleWriteInput = (
  request: RigLifecycleRequest,
  action: RigLifecycleWriteAction,
) => {
  const target = lifecycleTarget(request)
  return {
    action,
    project: request.project,
    ...(target.kind === "generated" ? {} : { lane: target.kind }),
    target,
    stateRoot: request.stateRoot,
    ...(request.config ? { config: request.config } : {}),
  }
}

const summarizeFailure = (failure: RigdHealthState["managedServiceFailures"][number]): string => [
  `${failure.deployment}/${failure.component} crashed at ${failure.occurredAt} after ${failure.recentCrashCount} recent ${
    failure.recentCrashCount === 1 ? "crash" : "crashes"
  }`,
  ...(failure.exitCode === undefined ? [] : [`exit code ${failure.exitCode}`]),
  ...(failure.stderr ? [`stderr: ${failure.stderr}`] : []),
].join("; ")

const summarizeRuntimeStatus = (status: RigdHealthState) => ({
  ...status,
  summary: {
    desiredDeployments: status.desiredDeployments.map((deployment) =>
      `${deployment.name} (${deployment.kind}) is ${deployment.desiredStatus} since ${deployment.updatedAt}`
    ),
    managedServiceFailures: status.managedServiceFailures.map(summarizeFailure),
  },
})

const pluralize = (count: number, singular: string, plural = `${singular}s`) =>
  count === 1 ? singular : plural

const logDetailText = (entry: RigdLogEntry): string => {
  const stream = typeof entry.details?.stream === "string" ? entry.details.stream : undefined
  const line = typeof entry.details?.line === "string" ? entry.details.line : undefined
  const operation = typeof entry.details?.operation === "string" ? entry.details.operation : undefined
  if (stream && line) {
    return `${stream}: ${line}`
  }
  if (operation) {
    return operation
  }
  return entry.event
}

const formatLogEntry = (entry: RigdLogEntry): string => {
  const target = entry.deployment ?? entry.lane ?? "host"
  const component = entry.component ? `/${entry.component}` : ""
  return `${entry.timestamp} ${target}${component} ${logDetailText(entry)}`
}

const formatLogEntries = (entries: readonly RigdLogEntry[]): string =>
  [
    "rig logs",
    ...(entries.length === 0 ? ["no log entries"] : entries.map(formatLogEntry)),
  ].join("\n")

type LogEntryCounts = Map<string, number>

const logEntryKey = (entry: RigdLogEntry): string =>
  JSON.stringify({
    timestamp: entry.timestamp,
    event: entry.event,
    project: entry.project,
    lane: entry.lane,
    deployment: entry.deployment,
    component: entry.component,
    details: entry.details,
  })

const markLogEntries = (entries: readonly RigdLogEntry[], counts: LogEntryCounts): void => {
  for (const entry of entries) {
    const key = logEntryKey(entry)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
}

const unseenLogEntries = (
  entries: readonly RigdLogEntry[],
  counts: LogEntryCounts,
): readonly RigdLogEntry[] => {
  const observed = new Map<string, number>()
  return entries.filter((entry) => {
    const key = logEntryKey(entry)
    const seenCount = counts.get(key) ?? 0
    const observedCount = observed.get(key) ?? 0
    observed.set(key, observedCount + 1)
    return observedCount >= seenCount
  })
}

const formatRuntimeStatus = (project: string, status: RigdHealthState): string => {
  const deploymentLines = status.desiredDeployments.length === 0
    ? ["deployments: none"]
    : [
      "deployments:",
      ...status.desiredDeployments.map((deployment) =>
        `  ${deployment.name} (${deployment.kind}): ${deployment.desiredStatus} since ${deployment.updatedAt}`
      ),
    ]
  const failureLines = status.managedServiceFailures.length === 0
    ? ["failures: none"]
    : [
      "failures:",
      ...status.managedServiceFailures.map((failure) => {
        const logHint = failure.deployment === "local" || failure.deployment === "live"
          ? `; logs: rig logs ${failure.deployment} --project ${project}`
          : `; logs: rig logs preview ${failure.deployment} --project ${project}`
        return [
          `  ${failure.deployment}/${failure.component}: crashed ${failure.recentCrashCount} ${
            pluralize(failure.recentCrashCount, "time")
          } at ${failure.occurredAt}`,
          ...(failure.exitCode === undefined ? [] : [`exit code ${failure.exitCode}`]),
          ...(failure.stderr ? [`stderr: ${failure.stderr}`] : []),
        ].join("; ") + logHint
      }),
    ]

  return [
    "rig runtime status",
    `rigd: ${status.rigd.status}`,
    ...deploymentLines,
    ...failureLines,
  ].join("\n")
}

export const RigLifecycleLive = Layer.effect(
  RigLifecycle,
  Effect.gen(function* () {
    const logger = yield* RigLogger
    const rigd = yield* Rigd

    return {
      run: (request) =>
        Effect.gen(function* () {
          if (request.action === "logs") {
            const target = lifecycleTarget(request)
            const scope = lifecycleTargetLogScope(target)
            const seen: LogEntryCounts = new Map()
            const logDetails = (entries: readonly RigdLogEntry[]) => ({
              project: request.project,
              target,
              ...scope,
              follow: request.follow ?? false,
              entries,
            })
            const entries = yield* rigd.logs({
              project: request.project,
              stateRoot: request.stateRoot,
              lines: request.lines ?? 50,
              target,
              ...scope,
            })
            markLogEntries(entries, seen)
            yield* logger.info(formatLogEntries(entries), logDetails(entries))
            if (request.follow) {
              yield* Effect.forever(Effect.gen(function* () {
                yield* Effect.sleep("1 second")
                const nextEntries = yield* rigd.logs({
                  project: request.project,
                  stateRoot: request.stateRoot,
                  lines: request.lines ?? 50,
                  target,
                  ...scope,
                })
                const unseen = unseenLogEntries(nextEntries, seen)
                if (unseen.length === 0) {
                  return
                }
                markLogEntries(unseen, seen)
                yield* logger.info(formatLogEntries(unseen), logDetails(unseen))
              }))
            }
            return
          }

          if (request.action === "status") {
            const status = yield* rigd.healthState({
              project: request.project,
              stateRoot: request.stateRoot,
              ...(request.config ? { config: request.config } : {}),
            })
            yield* logger.info(formatRuntimeStatus(request.project, status))
            if (request.structured) {
              yield* logger.info("rig runtime status details", summarizeRuntimeStatus(status))
            }
            return
          }

          if (request.action === "restart") {
            const stopped = yield* rigd.lifecycle(lifecycleWriteInput(request, "down"))
            const started = yield* rigd.lifecycle(lifecycleWriteInput(request, "up"))
            yield* logger.info("rig lifecycle restarted", {
              project: request.project,
              target: lifecycleTarget(request),
              ...(request.lane ? { lane: request.lane } : {}),
              stopped,
              started,
            })
            return
          }

          const receipt = yield* rigd.lifecycle(lifecycleWriteInput(request, request.action))
          yield* logger.info("rig lifecycle accepted", receipt)
        }),
    } satisfies RigLifecycleService
  }),
)
