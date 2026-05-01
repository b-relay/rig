import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import type { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
  V2RuntimeServiceConfig,
} from "../provider-contracts.js"

export interface V2StubPackageManagerAdapter {
  readonly install: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly service: V2RuntimeServiceConfig
    },
    selected: V2ProviderPluginForFamily<"package-manager">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const stubPackageManagerProvider = {
  id: "stub-package-manager",
  family: "package-manager",
  source: "first-party",
  displayName: "Stub Package Manager",
  capabilities: ["package-manager-contract-test"],
} satisfies V2ProviderPlugin

export const createStubPackageManagerAdapter = (): V2StubPackageManagerAdapter => ({
  install: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:install:${input.service.name}`),
})
