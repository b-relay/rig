import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import type { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
  V2RuntimeServiceConfig,
} from "../provider-contracts.js"

export interface V2StubLifecycleHookAdapter {
  readonly run: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly hook: "preStart" | "postStart" | "preStop" | "postStop"
      readonly command: string
      readonly service?: V2RuntimeServiceConfig
    },
    selected: V2ProviderPluginForFamily<"lifecycle-hook">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const stubLifecycleHookProvider = {
  id: "stub-lifecycle-hook",
  family: "lifecycle-hook",
  source: "first-party",
  displayName: "Stub Lifecycle Hook",
  capabilities: ["lifecycle-hook-contract-test"],
} satisfies V2ProviderPlugin

export const createStubLifecycleHookAdapter = (): V2StubLifecycleHookAdapter => ({
  run: (input, selected) =>
    Effect.succeed(`${selected.family}:${selected.id}:run:${input.hook}:${input.service?.name ?? "project"}`),
})
