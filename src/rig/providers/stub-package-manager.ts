import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import type { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
  RigRuntimeServiceConfig,
} from "../provider-contracts.js"

export interface RigStubPackageManagerAdapter {
  readonly install: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly service: RigRuntimeServiceConfig
    },
    selected: RigProviderPluginForFamily<"package-manager">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const stubPackageManagerProvider = {
  id: "stub-package-manager",
  family: "package-manager",
  source: "first-party",
  displayName: "Stub Package Manager",
  capabilities: ["package-manager-contract-test"],
} satisfies RigProviderPlugin

export const createStubPackageManagerAdapter = (): RigStubPackageManagerAdapter => ({
  install: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:install:${input.service.name}`),
})
