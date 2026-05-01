import { Effect } from "effect"

import type { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
  RigRuntimeServiceConfig,
} from "../provider-contracts.js"
import type { RigProcessSupervisorOperationResult } from "./process-supervisor.js"

export const stubProcessSupervisorProvider = {
  id: "stub-process-supervisor",
  family: "process-supervisor",
  source: "first-party",
  displayName: "Stub Process Supervisor",
  capabilities: ["process-supervisor-contract-test"],
} satisfies RigProviderPlugin

export const stubProcessSupervisorOperation = (
  provider: RigProviderPluginForFamily<"process-supervisor">,
  action: "up" | "down" | "restart",
  service: RigRuntimeServiceConfig,
): Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError> =>
  Effect.succeed({
    operation: `${provider.family}:${provider.id}:${action}:${service.name}`,
  })
