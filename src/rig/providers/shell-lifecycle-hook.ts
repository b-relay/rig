import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
  RigRuntimeServiceConfig,
} from "../provider-contracts.js"

export interface RigShellHookCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type RigShellHookCommandRunner = (
  args: readonly string[],
  options?: { readonly cwd?: string },
) => Effect.Effect<RigShellHookCommandResult, RigRuntimeError>

export interface RigShellLifecycleHookAdapter {
  readonly run: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly hook: "preStart" | "postStart" | "preStop" | "postStop"
      readonly command: string
      readonly service?: RigRuntimeServiceConfig
    },
    selected: RigProviderPluginForFamily<"lifecycle-hook">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const shellLifecycleHookProvider = {
  id: "shell-hook",
  family: "lifecycle-hook",
  source: "first-party",
  displayName: "Shell Lifecycle Hooks",
  capabilities: ["project-hooks", "component-hooks"],
} satisfies RigProviderPlugin

export const createShellLifecycleHookAdapter = (
  runPlatformCommand: RigShellHookCommandRunner,
): RigShellLifecycleHookAdapter => {
  const run = (input: {
    readonly deployment: RigDeploymentRecord
    readonly hook: "preStart" | "postStart" | "preStop" | "postStop"
    readonly command: string
    readonly service?: RigRuntimeServiceConfig
  }, selected: RigProviderPluginForFamily<"lifecycle-hook">): Effect.Effect<string, RigRuntimeError> =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runPlatformCommand(
        ["sh", "-lc", input.command],
        { cwd: input.deployment.workspacePath },
      )

      if (exitCode !== 0) {
        return yield* Effect.fail(new RigRuntimeError(
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
        cause instanceof RigRuntimeError
          ? cause
          : new RigRuntimeError(
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
