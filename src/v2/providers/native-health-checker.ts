import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
  V2RuntimeServiceConfig,
} from "../provider-contracts.js"

export interface V2NativeHealthCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type V2NativeHealthCommandRunner = (
  args: readonly string[],
  options?: { readonly cwd?: string },
) => Effect.Effect<V2NativeHealthCommandResult, V2RuntimeError>

export interface V2NativeHealthCheckerAdapter {
  readonly check: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly service: V2RuntimeServiceConfig
      readonly timeoutSeconds?: number
    },
    selected: V2ProviderPluginForFamily<"health-checker">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const nativeHealthCheckerProvider = {
  id: "native-health",
  family: "health-checker",
  source: "first-party",
  displayName: "Native Health Checks",
  capabilities: ["http-health", "command-health", "ownership-check"],
} satisfies V2ProviderPlugin

export const createNativeHealthCheckerAdapter = (
  runPlatformCommand: V2NativeHealthCommandRunner,
): V2NativeHealthCheckerAdapter => {
  const check = (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
    readonly timeoutSeconds?: number
  }, selected: V2ProviderPluginForFamily<"health-checker">): Effect.Effect<string, V2RuntimeError> => {
    const target = "healthCheck" in input.service ? input.service.healthCheck : undefined
    if (!target) {
      return Effect.fail(
        new V2RuntimeError(
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
          return yield* Effect.fail(new V2RuntimeError(
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
            throw new V2RuntimeError(
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
          cause instanceof V2RuntimeError
            ? cause
            : new V2RuntimeError(
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
          Effect.fail(new V2RuntimeError(
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
        if (cause instanceof V2RuntimeError) {
          return cause
        }
        return new V2RuntimeError(
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
