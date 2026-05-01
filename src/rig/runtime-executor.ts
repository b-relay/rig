import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"

import type { RigRuntimePlan, RigRuntimePlanComponent } from "./config.js"
import type { RigDeploymentRecord } from "./deployments.js"
import { platformMakeDirectory } from "./effect-platform.js"
import { RigRuntimeError } from "./errors.js"
import {
  RigEventTransportProvider,
  RigHealthCheckerProvider,
  RigLifecycleHookProvider,
  RigPackageManagerProvider,
  RigProcessSupervisorProvider,
  type RigProcessSupervisorOperationResult,
  type RigRuntimeServiceConfig,
  RigProxyRouterProvider,
  RigScmProvider,
  RigWorkspaceMaterializerProvider,
} from "./provider-contracts.js"

export interface RigRuntimeExecutionResult {
  readonly project: string
  readonly deployment: string
  readonly kind: RigDeploymentRecord["kind"]
  readonly providerProfile: RigDeploymentRecord["providerProfile"]
  readonly operations: readonly string[]
  readonly events: readonly RigRuntimeExecutionEvent[]
}

export interface RigRuntimeExecutionEvent {
  readonly event: string
  readonly project: string
  readonly lane?: "local" | "live"
  readonly deployment: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigManagedProcessExitHandlerInput {
  readonly deployment: RigDeploymentRecord
  readonly service: RigRuntimeServiceConfig
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

export type RigManagedProcessExitHandler = (
  input: RigManagedProcessExitHandlerInput,
) => Effect.Effect<void, RigRuntimeError>

export interface RigRuntimeLifecycleExecutionInput {
  readonly action: "up" | "down"
  readonly deployment: RigDeploymentRecord
  readonly onManagedProcessExit?: RigManagedProcessExitHandler
}

export interface RigRuntimeDeployExecutionInput {
  readonly deployment: RigDeploymentRecord
  readonly ref: string
  readonly onManagedProcessExit?: RigManagedProcessExitHandler
}

export interface RigRuntimeDestroyGeneratedExecutionInput {
  readonly deployment: RigDeploymentRecord
}

export interface RigRuntimeExecutorService {
  readonly lifecycle: (
    input: RigRuntimeLifecycleExecutionInput,
  ) => Effect.Effect<RigRuntimeExecutionResult, RigRuntimeError>
  readonly deploy: (
    input: RigRuntimeDeployExecutionInput,
  ) => Effect.Effect<RigRuntimeExecutionResult, RigRuntimeError>
  readonly destroyGenerated: (
    input: RigRuntimeDestroyGeneratedExecutionInput,
  ) => Effect.Effect<RigRuntimeExecutionResult, RigRuntimeError>
}

export const RigRuntimeExecutor =
  Context.Service<RigRuntimeExecutorService>("rig/rig/RigRuntimeExecutor")

type RigLifecycleHookName = "preStart" | "postStart" | "preStop" | "postStop"

interface RigLifecycleHooks {
  readonly preStart?: string | null
  readonly postStart?: string | null
  readonly preStop?: string | null
  readonly postStop?: string | null
}

const runtimePlan = (deployment: RigDeploymentRecord): RigRuntimePlan | undefined =>
  (deployment.resolved as { readonly runtimePlan?: RigRuntimePlan }).runtimePlan

const managedServiceFromPlan = (
  component: Extract<RigRuntimePlanComponent, { readonly kind: "managed" }>,
): RigRuntimeServiceConfig => ({
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
  component: Extract<RigRuntimePlanComponent, { readonly kind: "installed" }>,
): RigRuntimeServiceConfig => ({
  name: component.installName ?? component.name,
  type: "bin",
  entrypoint: component.entrypoint,
  ...(component.build ? { build: component.build } : {}),
  ...(component.hooks ? { hooks: component.hooks } : {}),
  ...(component.envFile ? { envFile: component.envFile } : {}),
})

const managedServices = (deployment: RigDeploymentRecord) =>
  runtimePlan(deployment)?.components
    .filter((component): component is Extract<RigRuntimePlanComponent, { readonly kind: "managed" }> =>
      component.kind === "managed"
    )
    .map(managedServiceFromPlan) ??
      deployment.resolved.environment.services.filter((service) => service.type === "server")

const installedServices = (deployment: RigDeploymentRecord) =>
  runtimePlan(deployment)?.components
    .filter((component): component is Extract<RigRuntimePlanComponent, { readonly kind: "installed" }> =>
      component.kind === "installed"
    )
    .map(installedServiceFromPlan) ??
      deployment.resolved.environment.services.filter((service) => service.type === "bin")

const preparedComponents = (deployment: RigDeploymentRecord) =>
  runtimePlan(deployment)?.preparedComponents ?? deployment.resolved.preparedComponents ?? []

const projectHooks = (deployment: RigDeploymentRecord): RigLifecycleHooks | undefined =>
  runtimePlan(deployment)?.hooks ?? deployment.resolved.v1Config?.hooks

const proxyConfig = (deployment: RigDeploymentRecord) =>
  runtimePlan(deployment)?.proxy ?? deployment.resolved.environment.proxy

const hookCommand = (
  hooks: RigLifecycleHooks | undefined,
  hook: RigLifecycleHookName,
): string | undefined => {
  const command = hooks?.[hook]
  return command && command.length > 0 ? command : undefined
}

const orderedManagedServices = (
  deployment: RigDeploymentRecord,
): Effect.Effect<readonly RigRuntimeServiceConfig[], RigRuntimeError> =>
  Effect.try({
    try: () => {
      const services = managedServices(deployment)
      const byName = new Map(services.map((service) => [service.name, service]))
      const visiting = new Set<string>()
      const visited = new Set<string>()
      const ordered: RigRuntimeServiceConfig[] = []

      const visit = (service: RigRuntimeServiceConfig) => {
        if (visited.has(service.name)) {
          return
        }
        if (visiting.has(service.name)) {
          throw new RigRuntimeError(
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
            throw new RigRuntimeError(
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
      cause instanceof RigRuntimeError
        ? cause
        : new RigRuntimeError(
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
  deployment: RigDeploymentRecord,
  operations: readonly string[],
  events: readonly RigRuntimeExecutionEvent[],
): RigRuntimeExecutionResult => ({
  project: deployment.project,
  deployment: deployment.name,
  kind: deployment.kind,
  providerProfile: deployment.providerProfile,
  operations,
  events,
})

const runtimeEvent = (
  deployment: RigDeploymentRecord,
  event: string,
  component: string | undefined,
  details: Readonly<Record<string, unknown>>,
): RigRuntimeExecutionEvent => ({
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
      readonly deployment: RigDeploymentRecord
      readonly event: string
      readonly component?: string
      readonly details?: Readonly<Record<string, unknown>>
    }) => Effect.Effect<string, RigRuntimeError>
  },
  deployment: RigDeploymentRecord,
  events: RigRuntimeExecutionEvent[],
  operations: string[],
  event: RigRuntimeExecutionEvent,
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
      readonly deployment: RigDeploymentRecord
      readonly event: string
      readonly component?: string
      readonly details?: Readonly<Record<string, unknown>>
    }) => Effect.Effect<string, RigRuntimeError>
  },
  deployment: RigDeploymentRecord,
  events: RigRuntimeExecutionEvent[],
  operations: string[],
  action: "up" | "down" | "deploy",
  component: string,
  result: RigProcessSupervisorOperationResult,
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
  deployment: RigDeploymentRecord,
  service: RigRuntimeServiceConfig,
  result: RigProcessSupervisorOperationResult,
  onManagedProcessExit: RigManagedProcessExitHandler | undefined,
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
      readonly deployment: RigDeploymentRecord
      readonly hook: RigLifecycleHookName
      readonly command: string
      readonly service?: RigRuntimeServiceConfig
    }) => Effect.Effect<string, RigRuntimeError>
  },
  operations: string[],
  input: {
    readonly deployment: RigDeploymentRecord
    readonly hook: RigLifecycleHookName
    readonly command?: string
    readonly service?: RigRuntimeServiceConfig
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
      readonly deployment: RigDeploymentRecord
      readonly event: string
      readonly component?: string
      readonly details?: Readonly<Record<string, unknown>>
    }) => Effect.Effect<string, RigRuntimeError>
  },
  deployment: RigDeploymentRecord,
  events: RigRuntimeExecutionEvent[],
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
          new RigRuntimeError(
            `Unable to prepare ${component.uses} component '${component.name}'.`,
            "Ensure the rig data root is writable and retry the lifecycle action.",
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

export const RigRuntimeExecutorLive = Layer.effect(
  RigRuntimeExecutor,
  Effect.gen(function* () {
    const processSupervisor = yield* RigProcessSupervisorProvider
    const proxyRouter = yield* RigProxyRouterProvider
    const scm = yield* RigScmProvider
    const workspaceMaterializer = yield* RigWorkspaceMaterializerProvider
    const eventTransport = yield* RigEventTransportProvider
    const healthChecker = yield* RigHealthCheckerProvider
    const lifecycleHook = yield* RigLifecycleHookProvider
    const packageManager = yield* RigPackageManagerProvider

    return {
      lifecycle: (input) => {
        const started: RigRuntimeServiceConfig[] = []

        return Effect.gen(function* () {
          const services = yield* orderedManagedServices(input.deployment)
          const ordered = input.action === "down" ? [...services].reverse() : services
          const operations: string[] = []
          const events: RigRuntimeExecutionEvent[] = []
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
            if (input.action === "up") {
              started.push(service)
            }
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
        }).pipe(
          Effect.catch((error) =>
            input.action === "up" && started.length > 0
              ? Effect.gen(function* () {
                for (const service of [...started].reverse()) {
                  yield* processSupervisor.down({ deployment: input.deployment, service })
                }
                return yield* Effect.fail(error)
              })
              : Effect.fail(error)
          ),
        )
      },
      deploy: (input) =>
        Effect.gen(function* () {
          const managed = yield* orderedManagedServices(input.deployment)
          const installed = installedServices(input.deployment)
          const proxy = proxyConfig(input.deployment)
          const operations: string[] = []
          const events: RigRuntimeExecutionEvent[] = []

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
          const events: RigRuntimeExecutionEvent[] = []

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
    } satisfies RigRuntimeExecutorService
  }),
)
