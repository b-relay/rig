import { Context, Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import type { RigRuntimeError } from "../errors.js"
import type {
  RigProviderFamilyService,
  RigProviderOutputLine,
  RigRuntimeServiceConfig,
} from "../provider-contracts.js"

export interface RigProcessSupervisorExitResult {
  readonly expected: boolean
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

export interface RigProcessSupervisorOperationResult {
  readonly operation: string
  readonly output?: readonly RigProviderOutputLine[]
  readonly exit?: Effect.Effect<RigProcessSupervisorExitResult, RigRuntimeError>
}

export interface RigProcessSupervisorProviderService
  extends RigProviderFamilyService<"process-supervisor"> {
  readonly up: (input: {
    readonly deployment: RigDeploymentRecord
    readonly service: RigRuntimeServiceConfig
  }) => Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError>
  readonly down: (input: {
    readonly deployment: RigDeploymentRecord
    readonly service: RigRuntimeServiceConfig
  }) => Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError>
  readonly restart: (input: {
    readonly deployment: RigDeploymentRecord
    readonly service: RigRuntimeServiceConfig
  }) => Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError>
}

export const RigProcessSupervisorProvider =
  Context.Service<RigProcessSupervisorProviderService>("rig/rig/RigProcessSupervisorProvider")
