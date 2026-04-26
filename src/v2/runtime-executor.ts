import { Context, Effect, Layer } from "effect-v4"

import type { V2DeploymentRecord } from "./deployments.js"
import { V2RuntimeError } from "./errors.js"
import {
  V2EventTransportProvider,
  V2HealthCheckerProvider,
  V2PackageManagerProvider,
  V2ProcessSupervisorProvider,
  V2ProxyRouterProvider,
  V2ScmProvider,
  V2WorkspaceMaterializerProvider,
  type V2ProviderPlugin,
} from "./provider-contracts.js"

export interface V2RuntimeExecutionResult {
  readonly project: string
  readonly deployment: string
  readonly kind: V2DeploymentRecord["kind"]
  readonly providerProfile: V2DeploymentRecord["providerProfile"]
  readonly operations: readonly string[]
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

const providerOperation = (provider: V2ProviderPlugin, operation: string): string =>
  `${provider.family}:${provider.id}:${operation}`

const managedServices = (deployment: V2DeploymentRecord) =>
  deployment.resolved.environment.services.filter((service) => service.type === "server")

const installedServices = (deployment: V2DeploymentRecord) =>
  deployment.resolved.environment.services.filter((service) => service.type === "bin")

const executionResult = (
  deployment: V2DeploymentRecord,
  operations: readonly string[],
): V2RuntimeExecutionResult => ({
  project: deployment.project,
  deployment: deployment.name,
  kind: deployment.kind,
  providerProfile: deployment.providerProfile,
  operations,
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

    const processPlugin = yield* processSupervisor.plugin
    const proxyPlugin = yield* proxyRouter.plugin
    const scmPlugin = yield* scm.plugin
    const workspacePlugin = yield* workspaceMaterializer.plugin
    const eventPlugin = yield* eventTransport.plugin
    const healthPlugin = yield* healthChecker.plugin
    const packagePlugin = yield* packageManager.plugin

    return {
      lifecycle: (input) =>
        Effect.gen(function* () {
          const services = managedServices(input.deployment)
          const ordered = input.action === "down" ? [...services].reverse() : services
          const operations = [
            providerOperation(workspacePlugin, `resolve:${input.deployment.workspacePath}`),
            ...ordered.map((service) => providerOperation(processPlugin, `${input.action}:${service.name}`)),
            ...(input.action === "up"
              ? services
                .filter((service) => service.healthCheck)
                .map((service) => providerOperation(healthPlugin, `check:${service.name}`))
              : []),
            providerOperation(eventPlugin, `append:lifecycle:${input.action}`),
          ]

          return executionResult(input.deployment, operations)
        }),
      deploy: (input) =>
        Effect.gen(function* () {
          const managed = managedServices(input.deployment)
          const installed = installedServices(input.deployment)
          const proxy = input.deployment.resolved.environment.proxy
          const operations = [
            providerOperation(scmPlugin, `checkout:${input.ref}`),
            providerOperation(workspacePlugin, `materialize:${input.deployment.workspacePath}`),
            ...installed.map((service) => providerOperation(packagePlugin, `install:${service.name}`)),
            ...managed.map((service) => providerOperation(processPlugin, `restart:${service.name}`)),
            ...managed
              .filter((service) => service.healthCheck)
              .map((service) => providerOperation(healthPlugin, `check:${service.name}`)),
            ...(proxy ? [providerOperation(proxyPlugin, `upsert:${proxy.upstream}`)] : []),
            providerOperation(eventPlugin, `append:deploy:${input.ref}`),
          ]

          return executionResult(input.deployment, operations)
        }),
      destroyGenerated: (input) =>
        Effect.gen(function* () {
          const services = [...managedServices(input.deployment)].reverse()
          const proxy = input.deployment.resolved.environment.proxy
          const operations = [
            ...services.map((service) => providerOperation(processPlugin, `stop:${service.name}`)),
            ...(proxy ? [providerOperation(proxyPlugin, `remove:${proxy.upstream}`)] : []),
            providerOperation(workspacePlugin, `remove:${input.deployment.workspacePath}`),
            providerOperation(eventPlugin, `append:destroy:${input.deployment.name}`),
          ]

          return executionResult(input.deployment, operations)
        }),
    } satisfies V2RuntimeExecutorService
  }),
)
