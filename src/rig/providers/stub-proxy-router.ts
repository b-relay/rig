import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import type { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
  RigRuntimeProxyConfig,
} from "../provider-contracts.js"

export interface RigStubProxyRouterAdapter {
  readonly upsert: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly proxy: RigRuntimeProxyConfig
    },
    selected: RigProviderPluginForFamily<"proxy-router">,
  ) => Effect.Effect<string, RigRuntimeError>
  readonly remove: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly proxy: RigRuntimeProxyConfig
    },
    selected: RigProviderPluginForFamily<"proxy-router">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const stubProxyRouterProvider = {
  id: "stub-proxy-router",
  family: "proxy-router",
  source: "first-party",
  displayName: "Stub Proxy Router",
  capabilities: ["proxy-router-contract-test"],
} satisfies RigProviderPlugin

export const createStubProxyRouterAdapter = (): RigStubProxyRouterAdapter => ({
  upsert: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:upsert:${input.proxy.upstream}`),
  remove: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:remove:${input.proxy.upstream}`),
})
