import { Effect } from "effect"

import type { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
  V2RuntimeServiceConfig,
} from "../provider-contracts.js"
import type { V2ProcessSupervisorOperationResult } from "./process-supervisor.js"

export const stubProcessSupervisorProvider = {
  id: "stub-process-supervisor",
  family: "process-supervisor",
  source: "first-party",
  displayName: "Stub Process Supervisor",
  capabilities: ["process-supervisor-contract-test"],
} satisfies V2ProviderPlugin

export const stubProcessSupervisorOperation = (
  provider: V2ProviderPluginForFamily<"process-supervisor">,
  action: "up" | "down" | "restart",
  service: V2RuntimeServiceConfig,
): Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError> =>
  Effect.succeed({
    operation: `${provider.family}:${provider.id}:${action}:${service.name}`,
  })
