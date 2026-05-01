import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"

import type { V2RuntimePlan, V2RuntimePlanComponent } from "./config.js"
import type { V2DeploymentRecord } from "./deployments.js"
import { platformMakeDirectory } from "./effect-platform.js"
import { V2RuntimeError } from "./errors.js"
import {
  V2EventTransportProvider,
  V2HealthCheckerProvider,
  V2LifecycleHookProvider,
  V2PackageManagerProvider,
  V2ProcessSupervisorProvider,
  type V2ProcessSupervisorOperationResult,
  type V2RuntimeServiceConfig,
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

export interface V2ManagedProcessExitHandlerInput {
  readonly deployment: V2DeploymentRecord
  readonly service: V2RuntimeServiceConfig
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

export type V2ManagedProcessExitHandler = (
  input: V2ManagedProcessExitHandlerInput,
) => Effect.Effect<void, V2RuntimeError>

export interface V2RuntimeLifecycleExecutionInput {
  readonly action: "up" | "down"
  readonly deployment: V2DeploymentRecord
  readonly onManagedProcessExit?: V2ManagedProcessExitHandler
}

export interface V2RuntimeDeployExecutionInput {
  readonly deployment: V2DeploymentRecord
  readonly ref: string
  readonly onManagedProcessExit?: V2ManagedProcessExitHandler
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

type V2LifecycleHookName = "preStart" | "postStart" | "preStop" | "postStop"

interface V2LifecycleHooks {
  readonly preStart?: string | null
  readonly postStart?: string | null
  readonly preStop?: string | null
  readonly postStop?: string | null
}

const runtimePlan = (deployment: V2DeploymentRecord): V2RuntimePlan | undefined =>
  (deployment.resolved as { readonly runtimePlan?: V2RuntimePlan }).runtimePlan

const managedServiceFromPlan = (
  component: Extract<V2RuntimePlanComponent, { readonly kind: "managed" }>,
): V2RuntimeServiceConfig => ({
  name: component.name,
  type: "server",
  command: component.command,
  port: component.port,
  ...(component.health ? { healthCheck: component.health } : {}),
  readyTimeout: component.readyTimeout,
  ...(component.dependsOn && component.dependsOn.length > 0 ? { dependsOn: component.dependsOn } : {}),
  ...(component.hooks ? { hooks: component.hooks } : {}),
  ...(component.envFile ? { envFile: component.envFile } : {}),
})

const installedServiceFromPlan = (
  component: Extract<V2RuntimePlanComponent, { readonly kind: "installed" }>,
): V2RuntimeServiceConfig => ({
  name: component.installName ?? component.name,
  type: "bin",
  entrypoint: component.entrypoint,
  ...(component.build ? { build: component.build } : {}),
  ...(component.hooks ? { hooks: component.hooks } : {}),
  ...(component.envFile ? { envFile: component.envFile } : {}),
})

const managedServices = (deployment: V2DeploymentRecord) =>
  runtimePlan(deployment)?.components
    .filter((component): component is Extract<V2RuntimePlanComponent, { readonly kind: "managed" }> =>
      component.kind === "managed"
    )
    .map(managedServiceFromPlan) ??
      deployment.resolved.environment.services.filter((service) => service.type === "server")

const installedServices = (deployment: V2DeploymentRecord) =>
  runtimePlan(deployment)?.components
    .filter((component): component is Extract<V2RuntimePlanComponent, { readonly kind: "installed" }> =>
      component.kind === "installed"
    )
    .map(installedServiceFromPlan) ??
      deployment.resolved.environment.services.filter((service) => service.type === "bin")

const preparedComponents = (deployment: V2DeploymentRecord) =>
  runtimePlan(deployment)?.preparedComponents ?? deployment.resolved.preparedComponents ?? []

const projectHooks = (deployment: V2DeploymentRecord): V2LifecycleHooks | undefined =>
  runtimePlan(deployment)?.hooks ?? deployment.resolved.v1Config?.hooks

const proxyConfig = (deployment: V2DeploymentRecord) =>
  runtimePlan(deployment)?.proxy ?? deployment.resolved.environment.proxy

const hookCommand = (
  hooks: V2LifecycleHooks | undefined,
  hook: V2LifecycleHookName,
): string | undefined => {
  const command = hooks?.[hook]
  return command && command.length > 0 ? command : undefined
}

const orderedManagedServices = (
  deployment: V2DeploymentRecord,
): Effect.Effect<readonly V2RuntimeServiceConfig[], V2RuntimeError> =>
  Effect.try({
    try: () => {
      const services = managedServices(deployment)
      const byName = new Map(services.map((service) => [service.name, service]))
      const visiting = new Set<string>()
      const visited = new Set<string>()
      const ordered: V2RuntimeServiceConfig[] = []

      const visit = (service: V2RuntimeServiceConfig) => {
        if (visited.has(service.name)) {
          return
        }
        if (visiting.has(service.name)) {
          throw new V2RuntimeError(
            `Managed component dependency cycle includes '${service.name}'.`,
            "Remove the cycle from dependsOn before running lifecycle actions.",
            { project: deployment.project, deployment: deployment.name, component: service.name },
          )
        }

        visiting.add(service.name)
        const dependencies = "dependsOn" in service ? service.dependsOn ?? [] : []
        for (const dependency of dependencies) {
          const dependencyService = byName.get(dependency)
          if (!dependencyService) {
            throw new V2RuntimeError(
              `Managed component '${service.name}' depends on unknown component '${dependency}'.`,
              "Fix the dependsOn entry so it references another managed component.",
              { project: deployment.project, deployment: deployment.name, component: service.name, dependency },
            )
          }
          visit(dependencyService)
        }
        visiting.delete(service.name)
        visited.add(service.name)
        ordered.push(service)
      }

      for (const service of services) {
        visit(service)
      }

      return ordered
    },
    catch: (cause) =>
      cause instanceof V2RuntimeError
        ? cause
        : new V2RuntimeError(
          "Unable to resolve managed component lifecycle order.",
          "Check dependsOn values before retrying the runtime action.",
          {
            project: deployment.project,
            deployment: deployment.name,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
  })

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

const startManagedProcessExitWatcher = (
  deployment: V2DeploymentRecord,
  service: V2RuntimeServiceConfig,
  result: V2ProcessSupervisorOperationResult,
  onManagedProcessExit: V2ManagedProcessExitHandler | undefined,
) =>
  result.exit && onManagedProcessExit
    ? result.exit.pipe(
      Effect.flatMap((exit) =>
        exit.expected
          ? Effect.void
          : onManagedProcessExit({
            deployment,
            service,
            ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
            ...(exit.stdout ? { stdout: exit.stdout } : {}),
            ...(exit.stderr ? { stderr: exit.stderr } : {}),
          })
      ),
      Effect.catch(() => Effect.void),
      Effect.forkDetach,
      Effect.asVoid,
    )
    : Effect.void

const appendHookOperation = (
  lifecycleHook: {
    readonly run: (input: {
      readonly deployment: V2DeploymentRecord
      readonly hook: V2LifecycleHookName
      readonly command: string
      readonly service?: V2RuntimeServiceConfig
    }) => Effect.Effect<string, V2RuntimeError>
  },
  operations: string[],
  input: {
    readonly deployment: V2DeploymentRecord
    readonly hook: V2LifecycleHookName
    readonly command?: string
    readonly service?: V2RuntimeServiceConfig
  },
) =>
  input.command
    ? Effect.gen(function* () {
      operations.push(yield* lifecycleHook.run({
        deployment: input.deployment,
        hook: input.hook,
        command: input.command as string,
        ...(input.service ? { service: input.service } : {}),
      }))
    })
    : Effect.void

const prepareDeploymentComponents = (
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
) =>
  Effect.forEach(preparedComponents(deployment), (component) =>
    Effect.gen(function* () {
      const directory = component.uses === "sqlite"
        ? dirname(component.path)
        : component.uses === "convex"
          ? component.stateDir
          : component.dataDir
      yield* platformMakeDirectory(directory).pipe(
        Effect.mapError((cause) =>
          new V2RuntimeError(
            `Unable to prepare ${component.uses} component '${component.name}'.`,
            "Ensure the v2 data root is writable and retry the lifecycle action.",
            {
              project: deployment.project,
              deployment: deployment.name,
              component: component.name,
              ...(component.uses === "sqlite"
                ? { path: component.path }
                : component.uses === "convex"
                  ? { stateDir: component.stateDir }
                  : { dataDir: component.dataDir }),
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          )
        ),
      )

      const event = runtimeEvent(deployment, "component.prepare", component.name, {
        uses: component.uses,
        ...(component.uses === "sqlite"
          ? { path: component.path }
          : component.uses === "convex"
            ? { stateDir: component.stateDir }
            : { dataDir: component.dataDir }),
        directory,
      })
      yield* appendRuntimeEvent(eventTransport, deployment, events, operations, event)
    }),
  ).pipe(Effect.asVoid)

export const V2RuntimeExecutorLive = Layer.effect(
  V2RuntimeExecutor,
  Effect.gen(function* () {
    const processSupervisor = yield* V2ProcessSupervisorProvider
    const proxyRouter = yield* V2ProxyRouterProvider
    const scm = yield* V2ScmProvider
    const workspaceMaterializer = yield* V2WorkspaceMaterializerProvider
    const eventTransport = yield* V2EventTransportProvider
    const healthChecker = yield* V2HealthCheckerProvider
    const lifecycleHook = yield* V2LifecycleHookProvider
    const packageManager = yield* V2PackageManagerProvider

    return {
      lifecycle: (input) =>
        Effect.gen(function* () {
          const services = yield* orderedManagedServices(input.deployment)
          const ordered = input.action === "down" ? [...services].reverse() : services
          const operations: string[] = []
          const events: V2RuntimeExecutionEvent[] = []
          const deploymentHooks = projectHooks(input.deployment)

          operations.push(yield* workspaceMaterializer.resolve({ deployment: input.deployment }))
          yield* appendHookOperation(lifecycleHook, operations, {
            deployment: input.deployment,
            hook: input.action === "up" ? "preStart" : "preStop",
            command: hookCommand(deploymentHooks, input.action === "up" ? "preStart" : "preStop"),
          })
          if (input.action === "up") {
            yield* prepareDeploymentComponents(eventTransport, input.deployment, events, operations)
          }
          for (const service of ordered) {
            yield* appendHookOperation(lifecycleHook, operations, {
              deployment: input.deployment,
              hook: input.action === "up" ? "preStart" : "preStop",
              command: hookCommand(service.hooks, input.action === "up" ? "preStart" : "preStop"),
              service,
            })
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
            if (input.action === "up") {
              yield* startManagedProcessExitWatcher(
                input.deployment,
                service,
                operation,
                input.onManagedProcessExit,
              )
            }
            if (input.action === "up" && service.healthCheck) {
              const operation = yield* healthChecker.check({
                deployment: input.deployment,
                service,
                timeoutSeconds: service.readyTimeout,
              })
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
            yield* appendHookOperation(lifecycleHook, operations, {
              deployment: input.deployment,
              hook: input.action === "up" ? "postStart" : "postStop",
              command: hookCommand(service.hooks, input.action === "up" ? "postStart" : "postStop"),
              service,
            })
          }
          yield* appendHookOperation(lifecycleHook, operations, {
            deployment: input.deployment,
            hook: input.action === "up" ? "postStart" : "postStop",
            command: hookCommand(deploymentHooks, input.action === "up" ? "postStart" : "postStop"),
          })
          operations.push(yield* eventTransport.append({
            deployment: input.deployment,
            event: `lifecycle:${input.action}`,
          }))

          return executionResult(input.deployment, operations, events)
        }),
      deploy: (input) =>
        Effect.gen(function* () {
          const managed = yield* orderedManagedServices(input.deployment)
          const installed = installedServices(input.deployment)
          const proxy = proxyConfig(input.deployment)
          const operations: string[] = []
          const events: V2RuntimeExecutionEvent[] = []

          operations.push(yield* scm.checkout({ deployment: input.deployment, ref: input.ref }))
          operations.push(yield* workspaceMaterializer.materialize({
            deployment: input.deployment,
            ref: input.ref,
          }))
          yield* prepareDeploymentComponents(eventTransport, input.deployment, events, operations)
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
            yield* startManagedProcessExitWatcher(
              input.deployment,
              service,
              operation,
              input.onManagedProcessExit,
            )
            if (service.healthCheck) {
              const healthOperation = yield* healthChecker.check({
                deployment: input.deployment,
                service,
                timeoutSeconds: service.readyTimeout,
              })
              operations.push(healthOperation)
              const event = runtimeEvent(input.deployment, "component.health", service.name, {
                operation: healthOperation,
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
          const services = [...(yield* orderedManagedServices(input.deployment))].reverse()
          const proxy = proxyConfig(input.deployment)
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
