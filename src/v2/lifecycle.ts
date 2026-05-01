import { Context, Effect, Layer } from "effect"

import type { V2ProjectConfig } from "./config.js"
import { V2Rigd, type V2RigdHealthState } from "./rigd.js"
import { V2Logger } from "./services.js"

export type V2LifecycleWriteAction = "up" | "down"
export type V2LifecycleAction = V2LifecycleWriteAction | "restart" | "logs" | "status"
export type V2LifecycleLane = "local" | "live"

export interface V2LifecycleRequest {
  readonly action: V2LifecycleAction
  readonly project: string
  readonly lane: V2LifecycleLane
  readonly stateRoot: string
  readonly config?: V2ProjectConfig
  readonly follow?: boolean
  readonly lines?: number
  readonly structured?: boolean
}

export interface V2LifecycleService {
  readonly run: (request: V2LifecycleRequest) => Effect.Effect<void>
}

export const V2Lifecycle = Context.Service<V2LifecycleService>("rig/v2/V2Lifecycle")

const lifecycleWriteInput = (
  request: V2LifecycleRequest,
  action: V2LifecycleWriteAction,
) => ({
  action,
  project: request.project,
  lane: request.lane,
  stateRoot: request.stateRoot,
  ...(request.config ? { config: request.config } : {}),
})

const summarizeFailure = (failure: V2RigdHealthState["managedServiceFailures"][number]): string => [
  `${failure.deployment}/${failure.component} crashed at ${failure.occurredAt} after ${failure.recentCrashCount} recent ${
    failure.recentCrashCount === 1 ? "crash" : "crashes"
  }`,
  ...(failure.exitCode === undefined ? [] : [`exit code ${failure.exitCode}`]),
  ...(failure.stderr ? [`stderr: ${failure.stderr}`] : []),
].join("; ")

const summarizeRuntimeStatus = (status: V2RigdHealthState) => ({
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

const formatRuntimeStatus = (project: string, status: V2RigdHealthState): string => {
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
          ? `; logs: rig logs --project ${project} --lane ${failure.deployment}`
          : ""
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

export const V2LifecycleLive = Layer.effect(
  V2Lifecycle,
  Effect.gen(function* () {
    const logger = yield* V2Logger
    const rigd = yield* V2Rigd

    return {
      run: (request) =>
        Effect.gen(function* () {
          if (request.action === "logs") {
            const entries = yield* rigd.logs({
              project: request.project,
              stateRoot: request.stateRoot,
              lines: request.lines ?? 50,
            })
            yield* logger.info("rig logs", {
              project: request.project,
              lane: request.lane,
              follow: request.follow ?? false,
              entries,
            })
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
              lane: request.lane,
              stopped,
              started,
            })
            return
          }

          const receipt = yield* rigd.lifecycle(lifecycleWriteInput(request, request.action))
          yield* logger.info("rig lifecycle accepted", receipt)
        }),
    } satisfies V2LifecycleService
  }),
)
