import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import type { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
  V2RuntimeServiceConfig,
} from "../provider-contracts.js"

export interface V2StubHealthCheckerAdapter {
  readonly check: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly service: V2RuntimeServiceConfig
      readonly timeoutSeconds?: number
    },
    selected: V2ProviderPluginForFamily<"health-checker">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const stubHealthCheckerProvider = {
  id: "stub-health-checker",
  family: "health-checker",
  source: "first-party",
  displayName: "Stub Health Checker",
  capabilities: ["health-checker-contract-test"],
} satisfies V2ProviderPlugin

export const createStubHealthCheckerAdapter = (): V2StubHealthCheckerAdapter => ({
  check: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:check:${input.service.name}`),
})
