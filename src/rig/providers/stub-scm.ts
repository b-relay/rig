import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import type { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
} from "../provider-contracts.js"

export interface RigStubScmAdapter {
  readonly checkout: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly ref: string
    },
    selected: RigProviderPluginForFamily<"scm">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const stubScmProvider = {
  id: "stub-scm",
  family: "scm",
  source: "first-party",
  displayName: "Stub SCM",
  capabilities: ["scm-contract-test"],
} satisfies RigProviderPlugin

export const createStubScmAdapter = (): RigStubScmAdapter => ({
  checkout: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:checkout:${input.ref}`),
})
