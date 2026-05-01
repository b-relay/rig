import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
  RigRuntimeServiceConfig,
} from "../provider-contracts.js"

export interface RigNativeHealthCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type RigNativeHealthCommandRunner = (
  args: readonly string[],
  options?: { readonly cwd?: string },
) => Effect.Effect<RigNativeHealthCommandResult, RigRuntimeError>

export interface RigNativeHealthCheckerAdapter {
  readonly check: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly service: RigRuntimeServiceConfig
      readonly timeoutSeconds?: number
    },
    selected: RigProviderPluginForFamily<"health-checker">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const nativeHealthCheckerProvider = {
  id: "native-health",
  family: "health-checker",
  source: "first-party",
  displayName: "Native Health Checks",
  capabilities: ["http-health", "command-health", "ownership-check"],
} satisfies RigProviderPlugin

export const createNativeHealthCheckerAdapter = (
  runPlatformCommand: RigNativeHealthCommandRunner,
): RigNativeHealthCheckerAdapter => {
  const check = (input: {
    readonly deployment: RigDeploymentRecord
    readonly service: RigRuntimeServiceConfig
    readonly timeoutSeconds?: number
  }, selected: RigProviderPluginForFamily<"health-checker">): Effect.Effect<string, RigRuntimeError> => {
    const target = "healthCheck" in input.service ? input.service.healthCheck : undefined
    if (!target) {
      return Effect.fail(
        new RigRuntimeError(
          `Component '${input.service.name}' does not define a health check.`,
          "Add a health check to the managed component before asking native-health to verify it.",
          {
            providerId: selected.id,
            component: input.service.name,
            deployment: input.deployment.name,
          },
        ),
      )
    }

    const timeoutSeconds = input.timeoutSeconds
      ?? ("readyTimeout" in input.service ? input.service.readyTimeout : undefined)
      ?? 30

    const healthCheck = !target.startsWith("http://") && !target.startsWith("https://")
      ? Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runPlatformCommand(
          ["sh", "-lc", target],
          { cwd: input.deployment.workspacePath },
        )

        if (exitCode !== 0) {
          return yield* Effect.fail(new RigRuntimeError(
            `Command health check failed for '${input.service.name}' with exit code ${exitCode}.`,
            "Fix the component health command before retrying the runtime action.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              target,
              exitCode,
              stdout,
              stderr,
            },
          ))
        }

        return `${selected.family}:${selected.id}:check:${input.service.name}:command:healthy:${exitCode}`
      })
      : Effect.tryPromise({
        try: async () => {
          const response = await fetch(target)
          if (response.status < 200 || response.status >= 300) {
            throw new RigRuntimeError(
              `Health check failed for '${input.service.name}' with HTTP ${response.status}.`,
              "Fix the component startup or health endpoint before retrying the runtime action.",
              {
                providerId: selected.id,
                component: input.service.name,
                deployment: input.deployment.name,
                target,
                statusCode: response.status,
              },
            )
          }

          return `${selected.family}:${selected.id}:check:${input.service.name}:healthy:${response.status}`
        },
        catch: (cause) =>
          cause instanceof RigRuntimeError
            ? cause
            : new RigRuntimeError(
              `Unable to run health check for '${input.service.name}'.`,
              "Ensure the health endpoint is reachable from localhost and retry.",
              {
                providerId: selected.id,
                component: input.service.name,
                deployment: input.deployment.name,
                target,
                cause: cause instanceof Error ? cause.message : String(cause),
              },
            ),
      })

    return healthCheck.pipe(
      Effect.timeoutOrElse({
        duration: `${timeoutSeconds} seconds`,
        orElse: () =>
          Effect.fail(new RigRuntimeError(
            `Health check timed out for '${input.service.name}' after ${timeoutSeconds} seconds.`,
            "Increase readyTimeout or fix the component so its health check completes in time.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              target,
              timeoutSeconds,
            },
          )),
      }),
      Effect.mapError((cause) => {
        if (cause instanceof RigRuntimeError) {
          return cause
        }
        return new RigRuntimeError(
          `Unable to run health check for '${input.service.name}'.`,
          "Ensure the health endpoint is reachable from localhost and retry.",
          {
            providerId: selected.id,
            component: input.service.name,
            deployment: input.deployment.name,
            target,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        )
      }),
    )
  }

  return { check }
}
