import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import type { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
} from "../provider-contracts.js"

export interface V2StubScmAdapter {
  readonly checkout: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly ref: string
    },
    selected: V2ProviderPluginForFamily<"scm">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const stubScmProvider = {
  id: "stub-scm",
  family: "scm",
  source: "first-party",
  displayName: "Stub SCM",
  capabilities: ["scm-contract-test"],
} satisfies V2ProviderPlugin

export const createStubScmAdapter = (): V2StubScmAdapter => ({
  checkout: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:checkout:${input.ref}`),
})
