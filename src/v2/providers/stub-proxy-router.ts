import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import type { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
  V2RuntimeProxyConfig,
} from "../provider-contracts.js"

export interface V2StubProxyRouterAdapter {
  readonly upsert: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly proxy: V2RuntimeProxyConfig
    },
    selected: V2ProviderPluginForFamily<"proxy-router">,
  ) => Effect.Effect<string, V2RuntimeError>
  readonly remove: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly proxy: V2RuntimeProxyConfig
    },
    selected: V2ProviderPluginForFamily<"proxy-router">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const stubProxyRouterProvider = {
  id: "stub-proxy-router",
  family: "proxy-router",
  source: "first-party",
  displayName: "Stub Proxy Router",
  capabilities: ["proxy-router-contract-test"],
} satisfies V2ProviderPlugin

export const createStubProxyRouterAdapter = (): V2StubProxyRouterAdapter => ({
  upsert: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:upsert:${input.proxy.upstream}`),
  remove: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:remove:${input.proxy.upstream}`),
})
