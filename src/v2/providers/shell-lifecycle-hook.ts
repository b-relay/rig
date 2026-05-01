import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
  V2RuntimeServiceConfig,
} from "../provider-contracts.js"

export interface V2ShellHookCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type V2ShellHookCommandRunner = (
  args: readonly string[],
  options?: { readonly cwd?: string },
) => Effect.Effect<V2ShellHookCommandResult, V2RuntimeError>

export interface V2ShellLifecycleHookAdapter {
  readonly run: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly hook: "preStart" | "postStart" | "preStop" | "postStop"
      readonly command: string
      readonly service?: V2RuntimeServiceConfig
    },
    selected: V2ProviderPluginForFamily<"lifecycle-hook">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const shellLifecycleHookProvider = {
  id: "shell-hook",
  family: "lifecycle-hook",
  source: "first-party",
  displayName: "Shell Lifecycle Hooks",
  capabilities: ["project-hooks", "component-hooks"],
} satisfies V2ProviderPlugin

export const createShellLifecycleHookAdapter = (
  runPlatformCommand: V2ShellHookCommandRunner,
): V2ShellLifecycleHookAdapter => {
  const run = (input: {
    readonly deployment: V2DeploymentRecord
    readonly hook: "preStart" | "postStart" | "preStop" | "postStop"
    readonly command: string
    readonly service?: V2RuntimeServiceConfig
  }, selected: V2ProviderPluginForFamily<"lifecycle-hook">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runPlatformCommand(
        ["sh", "-lc", input.command],
        { cwd: input.deployment.workspacePath },
      )

      if (exitCode !== 0) {
        return yield* Effect.fail(new V2RuntimeError(
          `Lifecycle hook '${input.hook}' failed${input.service ? ` for '${input.service.name}'` : ""} with exit code ${exitCode}.`,
          "Fix the hook command before retrying the runtime action.",
          {
            providerId: selected.id,
            hook: input.hook,
            command: input.command,
            project: input.deployment.project,
            deployment: input.deployment.name,
            ...(input.service ? { component: input.service.name } : {}),
            exitCode,
            stdout,
            stderr,
          },
        ))
      }

      return `${selected.family}:${selected.id}:run:${input.hook}:${input.service?.name ?? "project"}:${exitCode}`
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof V2RuntimeError
          ? cause
          : new V2RuntimeError(
            `Unable to run lifecycle hook '${input.hook}'${input.service ? ` for '${input.service.name}'` : ""}.`,
            "Ensure the hook command can run from the deployment workspace and retry.",
            {
              providerId: selected.id,
              hook: input.hook,
              command: input.command,
              project: input.deployment.project,
              deployment: input.deployment.name,
              ...(input.service ? { component: input.service.name } : {}),
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          )),
    )

  return { run }
}
