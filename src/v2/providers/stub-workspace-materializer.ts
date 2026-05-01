import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import type { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
} from "../provider-contracts.js"

export interface V2StubWorkspaceMaterializerAdapter {
  readonly resolve: (
    input: {
      readonly deployment: V2DeploymentRecord
    },
    selected: V2ProviderPluginForFamily<"workspace-materializer">,
  ) => Effect.Effect<string, V2RuntimeError>
  readonly materialize: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly ref: string
    },
    selected: V2ProviderPluginForFamily<"workspace-materializer">,
  ) => Effect.Effect<string, V2RuntimeError>
  readonly remove: (
    input: {
      readonly deployment: V2DeploymentRecord
    },
    selected: V2ProviderPluginForFamily<"workspace-materializer">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const stubWorkspaceMaterializerProvider = {
  id: "stub-workspace-materializer",
  family: "workspace-materializer",
  source: "first-party",
  displayName: "Stub Workspace Materializer",
  capabilities: ["workspace-materializer-contract-test"],
} satisfies V2ProviderPlugin

export const createStubWorkspaceMaterializerAdapter = (): V2StubWorkspaceMaterializerAdapter => ({
  resolve: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:resolve:${input.deployment.workspacePath}`),
  materialize: (input, selected) =>
    Effect.succeed(`${selected.family}:${selected.id}:materialize:${input.deployment.workspacePath}`),
  remove: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:remove:${input.deployment.workspacePath}`),
})
