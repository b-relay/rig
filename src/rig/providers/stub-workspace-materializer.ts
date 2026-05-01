import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import type { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
} from "../provider-contracts.js"

export interface RigStubWorkspaceMaterializerAdapter {
  readonly resolve: (
    input: {
      readonly deployment: RigDeploymentRecord
    },
    selected: RigProviderPluginForFamily<"workspace-materializer">,
  ) => Effect.Effect<string, RigRuntimeError>
  readonly materialize: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly ref: string
    },
    selected: RigProviderPluginForFamily<"workspace-materializer">,
  ) => Effect.Effect<string, RigRuntimeError>
  readonly remove: (
    input: {
      readonly deployment: RigDeploymentRecord
    },
    selected: RigProviderPluginForFamily<"workspace-materializer">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const stubWorkspaceMaterializerProvider = {
  id: "stub-workspace-materializer",
  family: "workspace-materializer",
  source: "first-party",
  displayName: "Stub Workspace Materializer",
  capabilities: ["workspace-materializer-contract-test"],
} satisfies RigProviderPlugin

export const createStubWorkspaceMaterializerAdapter = (): RigStubWorkspaceMaterializerAdapter => ({
  resolve: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:resolve:${input.deployment.workspacePath}`),
  materialize: (input, selected) =>
    Effect.succeed(`${selected.family}:${selected.id}:materialize:${input.deployment.workspacePath}`),
  remove: (input, selected) => Effect.succeed(`${selected.family}:${selected.id}:remove:${input.deployment.workspacePath}`),
})
