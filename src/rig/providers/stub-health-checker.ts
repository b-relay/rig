import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import type { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
  RigRuntimeServiceConfig,
} from "../provider-contracts.js"

export interface RigStubHealthCheckerAdapter {
  readonly check: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly service: RigRuntimeServiceConfig
      readonly timeoutSeconds?: number
    },
    selected: RigProviderPluginForFamily<"health-checker">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const stubHealthCheckerProvider = {
  id: "stub-health-checker",
  family: "health-checker",
  source: "first-party",
  displayName: "Stub Health Checker",
  capabilities: ["health-checker-contract-test"],
} satisfies RigProviderPlugin

export const createStubHealthCheckerAdapter = (): RigStubHealthCheckerAdapter => ({
  check: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:check:${input.service.name}`),
})
