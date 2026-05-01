import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import type { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
} from "../provider-contracts.js"

export interface V2StubEventTransportInput {
  readonly deployment: V2DeploymentRecord
  readonly event: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2StubEventTransportAdapter {
  readonly append: (
    input: V2StubEventTransportInput,
    selected: V2ProviderPluginForFamily<"event-transport">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const stubEventTransportProvider = {
  id: "stub-event-transport",
  family: "event-transport",
  source: "first-party",
  displayName: "Stub Event Transport",
  capabilities: ["event-transport-contract-test"],
} satisfies V2ProviderPlugin

export const createStubEventTransportAdapter = (): V2StubEventTransportAdapter => ({
  append: (input, selected) =>
    Effect.succeed(`${selected.family}:${selected.id}:append:${input.event}${input.component ? `:${input.component}` : ""}`),
})
