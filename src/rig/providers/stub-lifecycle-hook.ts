import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import type { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
  RigRuntimeServiceConfig,
} from "../provider-contracts.js"

export interface RigStubLifecycleHookAdapter {
  readonly run: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly hook: "preStart" | "postStart" | "preStop" | "postStop"
      readonly command: string
      readonly service?: RigRuntimeServiceConfig
    },
    selected: RigProviderPluginForFamily<"lifecycle-hook">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const stubLifecycleHookProvider = {
  id: "stub-lifecycle-hook",
  family: "lifecycle-hook",
  source: "first-party",
  displayName: "Stub Lifecycle Hook",
  capabilities: ["lifecycle-hook-contract-test"],
} satisfies RigProviderPlugin

export const createStubLifecycleHookAdapter = (): RigStubLifecycleHookAdapter => ({
  run: (input, selected) =>
    Effect.succeed(`${selected.family}:${selected.id}:run:${input.hook}:${input.service?.name ?? "project"}`),
})
