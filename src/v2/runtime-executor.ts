import { Context, Effect, Layer } from "effect"

import type { V2DeploymentRecord } from "./deployments.js"
import { V2RuntimeError } from "./errors.js"
import {
  V2EventTransportProvider,
  V2HealthCheckerProvider,
  V2PackageManagerProvider,
  V2ProcessSupervisorProvider,
  type V2ProcessSupervisorOperationResult,
  V2ProxyRouterProvider,
  V2ScmProvider,
  V2WorkspaceMaterializerProvider,
} from "./provider-contracts.js"

export interface V2RuntimeExecutionResult {
  readonly project: string
  readonly deployment: string
  readonly kind: V2DeploymentRecord["kind"]
  readonly providerProfile: V2DeploymentRecord["providerProfile"]
  readonly operations: readonly string[]
  readonly events: readonly V2RuntimeExecutionEvent[]
}

export interface V2RuntimeExecutionEvent {
  readonly event: string
  readonly project: string
  readonly lane?: "local" | "live"
  readonly deployment: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2RuntimeLifecycleExecutionInput {
  readonly action: "up" | "down"
  readonly deployment: V2DeploymentRecord
}

export interface V2RuntimeDeployExecutionInput {
  readonly deployment: V2DeploymentRecord
  readonly ref: string
}

export interface V2RuntimeDestroyGeneratedExecutionInput {
  readonly deployment: V2DeploymentRecord
}

export interface V2RuntimeExecutorService {
  readonly lifecycle: (
    input: V2RuntimeLifecycleExecutionInput,
  ) => Effect.Effect<V2RuntimeExecutionResult, V2RuntimeError>
  readonly deploy: (
    input: V2RuntimeDeployExecutionInput,
  ) => Effect.Effect<V2RuntimeExecutionResult, V2RuntimeError>
  readonly destroyGenerated: (
    input: V2RuntimeDestroyGeneratedExecutionInput,
  ) => Effect.Effect<V2RuntimeExecutionResult, V2RuntimeError>
}

export const V2RuntimeExecutor =
  Context.Service<V2RuntimeExecutorService>("rig/v2/V2RuntimeExecutor")

const managedServices = (deployment: V2DeploymentRecord) =>
  deployment.resolved.environment.services.filter((service) => service.type === "server")

const installedServices = (deployment: V2DeploymentRecord) =>
  deployment.resolved.environment.services.filter((service) => service.type === "bin")

const executionResult = (
  deployment: V2DeploymentRecord,
  operations: readonly string[],
  events: readonly V2RuntimeExecutionEvent[],
): V2RuntimeExecutionResult => ({
  project: deployment.project,
  deployment: deployment.name,
  kind: deployment.kind,
  providerProfile: deployment.providerProfile,
  operations,
  events,
})

const runtimeEvent = (
  deployment: V2DeploymentRecord,
  event: string,
  component: string | undefined,
  details: Readonly<Record<string, unknown>>,
): V2RuntimeExecutionEvent => ({
  event,
  project: deployment.project,
  ...(deployment.kind === "local" || deployment.kind === "live" ? { lane: deployment.kind } : {}),
  deployment: deployment.name,
  ...(component ? { component } : {}),
  details,
})

const appendRuntimeEvent = (
  eventTransport: {
    readonly append: (input: {
      readonly deployment: V2DeploymentRecord
      readonly event: string
      readonly component?: string
      readonly details?: Readonly<Record<string, unknown>>
    }) => Effect.Effect<string, V2RuntimeError>
  },
  deployment: V2DeploymentRecord,
  events: V2RuntimeExecutionEvent[],
  operations: string[],
  event: V2RuntimeExecutionEvent,
) =>
  Effect.gen(function* () {
    events.push(event)
    operations.push(yield* eventTransport.append({
      deployment,
      event: event.event,
      ...(event.component ? { component: event.component } : {}),
      details: event.details,
    }))
  })

const appendProcessEvents = (
  eventTransport: {
    readonly append: (input: {
      readonly deployment: V2DeploymentRecord
      readonly event: string
      readonly component?: string
      readonly details?: Readonly<Record<string, unknown>>
    }) => Effect.Effect<string, V2RuntimeError>
  },
  deployment: V2DeploymentRecord,
  events: V2RuntimeExecutionEvent[],
  operations: string[],
  action: "up" | "down" | "deploy",
  component: string,
  result: V2ProcessSupervisorOperationResult,
) =>
  Effect.gen(function* () {
    const operationEvent = runtimeEvent(deployment, "component.log", component, {
      action,
      operation: result.operation,
    })
    yield* appendRuntimeEvent(eventTransport, deployment, events, operations, operationEvent)

    for (const output of result.output ?? []) {
      const outputEvent = runtimeEvent(deployment, "component.log", component, {
        action,
        operation: result.operation,
        stream: output.stream,
        line: output.line,
      })
      yield* appendRuntimeEvent(eventTransport, deployment, events, operations, outputEvent)
    }
  })

export const V2RuntimeExecutorLive = Layer.effect(
  V2RuntimeExecutor,
  Effect.gen(function* () {
    const processSupervisor = yield* V2ProcessSupervisorProvider
    const proxyRouter = yield* V2ProxyRouterProvider
    const scm = yield* V2ScmProvider
    const workspaceMaterializer = yield* V2WorkspaceMaterializerProvider
    const eventTransport = yield* V2EventTransportProvider
    const healthChecker = yield* V2HealthCheckerProvider
    const packageManager = yield* V2PackageManagerProvider

    return {
      lifecycle: (input) =>
        Effect.gen(function* () {
          const services = managedServices(input.deployment)
          const ordered = input.action === "down" ? [...services].reverse() : services
          const operations: string[] = []
          const events: V2RuntimeExecutionEvent[] = []

          operations.push(yield* workspaceMaterializer.resolve({ deployment: input.deployment }))
          for (const service of ordered) {
            const operation = yield* (input.action === "up"
              ? processSupervisor.up({ deployment: input.deployment, service })
              : processSupervisor.down({ deployment: input.deployment, service }))
            operations.push(operation.operation)
            yield* appendProcessEvents(
              eventTransport,
              input.deployment,
              events,
              operations,
              input.action,
              service.name,
              operation,
            )
          }
          if (input.action === "up") {
            for (const service of services.filter((service) => service.healthCheck)) {
              const operation = yield* healthChecker.check({ deployment: input.deployment, service })
              operations.push(operation)
              const event = runtimeEvent(input.deployment, "component.health", service.name, {
                operation,
              })
              events.push(event)
              operations.push(yield* eventTransport.append({
                deployment: input.deployment,
                event: event.event,
                component: service.name,
                details: event.details,
              }))
            }
          }
          operations.push(yield* eventTransport.append({
            deployment: input.deployment,
            event: `lifecycle:${input.action}`,
          }))

          return executionResult(input.deployment, operations, events)
        }),
      deploy: (input) =>
        Effect.gen(function* () {
          const managed = managedServices(input.deployment)
          const installed = installedServices(input.deployment)
          const proxy = input.deployment.resolved.environment.proxy
          const operations: string[] = []
          const events: V2RuntimeExecutionEvent[] = []

          operations.push(yield* scm.checkout({ deployment: input.deployment, ref: input.ref }))
          operations.push(yield* workspaceMaterializer.materialize({
            deployment: input.deployment,
            ref: input.ref,
          }))
          for (const service of installed) {
            const operation = yield* packageManager.install({ deployment: input.deployment, service })
            operations.push(operation)
            const event = runtimeEvent(input.deployment, "component.install", service.name, {
              action: "deploy",
              operation,
            })
            events.push(event)
            operations.push(yield* eventTransport.append({
              deployment: input.deployment,
              event: event.event,
              component: service.name,
              details: event.details,
            }))
          }
          for (const service of managed) {
            const operation = yield* processSupervisor.restart({ deployment: input.deployment, service })
            operations.push(operation.operation)
            yield* appendProcessEvents(
              eventTransport,
              input.deployment,
              events,
              operations,
              "deploy",
              service.name,
              operation,
            )
          }
          for (const service of managed.filter((service) => service.healthCheck)) {
            const operation = yield* healthChecker.check({ deployment: input.deployment, service })
            operations.push(operation)
            const event = runtimeEvent(input.deployment, "component.health", service.name, {
              operation,
            })
            events.push(event)
            operations.push(yield* eventTransport.append({
              deployment: input.deployment,
              event: event.event,
              component: service.name,
              details: event.details,
            }))
          }
          if (proxy) {
            operations.push(yield* proxyRouter.upsert({ deployment: input.deployment, proxy }))
          }
          operations.push(yield* eventTransport.append({
            deployment: input.deployment,
            event: `deploy:${input.ref}`,
          }))

          return executionResult(input.deployment, operations, events)
        }),
      destroyGenerated: (input) =>
        Effect.gen(function* () {
          const services = [...managedServices(input.deployment)].reverse()
          const proxy = input.deployment.resolved.environment.proxy
          const operations: string[] = []
          const events: V2RuntimeExecutionEvent[] = []

          for (const service of services) {
            const operation = yield* processSupervisor.down({ deployment: input.deployment, service })
            operations.push(operation.operation)
            yield* appendProcessEvents(
              eventTransport,
              input.deployment,
              events,
              operations,
              "down",
              service.name,
              operation,
            )
          }
          if (proxy) {
            operations.push(yield* proxyRouter.remove({ deployment: input.deployment, proxy }))
          }
          operations.push(yield* workspaceMaterializer.remove({ deployment: input.deployment }))
          operations.push(yield* eventTransport.append({
            deployment: input.deployment,
            event: `destroy:${input.deployment.name}`,
          }))

          return executionResult(input.deployment, operations, events)
        }),
    } satisfies V2RuntimeExecutorService
  }),
)
