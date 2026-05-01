import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import type { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
} from "../provider-contracts.js"

export interface RigStubEventTransportInput {
  readonly deployment: RigDeploymentRecord
  readonly event: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigStubEventTransportAdapter {
  readonly append: (
    input: RigStubEventTransportInput,
    selected: RigProviderPluginForFamily<"event-transport">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const stubEventTransportProvider = {
  id: "stub-event-transport",
  family: "event-transport",
  source: "first-party",
  displayName: "Stub Event Transport",
  capabilities: ["event-transport-contract-test"],
} satisfies RigProviderPlugin

export const createStubEventTransportAdapter = (): RigStubEventTransportAdapter => ({
  append: (input, selected) =>
    Effect.succeed(`${selected.family}:${selected.id}:append:${input.event}${input.component ? `:${input.component}` : ""}`),
})
