import { Context, Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import type { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderFamilyService,
  V2ProviderOutputLine,
  V2RuntimeServiceConfig,
} from "../provider-contracts.js"

export interface V2ProcessSupervisorExitResult {
  readonly expected: boolean
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

export interface V2ProcessSupervisorOperationResult {
  readonly operation: string
  readonly output?: readonly V2ProviderOutputLine[]
  readonly exit?: Effect.Effect<V2ProcessSupervisorExitResult, V2RuntimeError>
}

export interface V2ProcessSupervisorProviderService
  extends V2ProviderFamilyService<"process-supervisor"> {
  readonly up: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError>
  readonly down: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError>
  readonly restart: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError>
}

export const V2ProcessSupervisorProvider =
  Context.Service<V2ProcessSupervisorProviderService>("rig/v2/V2ProcessSupervisorProvider")
