import { Effect, Layer } from "effect"

import {
  HookRunner,
  type HookRunResult,
  type HookRunner as HookRunnerService,
} from "../interfaces/hook-runner.js"
import { ServiceRunnerError } from "../schema/errors.js"

const mergeRuntimeEnv = (
  envVars: Readonly<Record<string, string>>,
): Record<string, string> => {
  const merged: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      merged[key] = value
    }
  }

  for (const [key, value] of Object.entries(envVars)) {
    merged[key] = value
  }

  return merged
}

export class StubHookRunner implements HookRunnerService {
  readonly calls: Array<{ readonly command: string; readonly workdir: string }> = []

  runHook(
    command: string,
    opts: { readonly workdir: string; readonly env: Readonly<Record<string, string>> },
  ): Effect.Effect<HookRunResult, ServiceRunnerError> {
    this.calls.push({ command, workdir: opts.workdir })

    return Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(["sh", "-c", command], {
          cwd: opts.workdir,
          env: mergeRuntimeEnv(opts.env),
          stdout: "pipe",
          stderr: "pipe",
        })

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])

        return { exitCode, stdout, stderr }
      },
      catch: (cause) =>
        new ServiceRunnerError(
          "start",
          "hook",
          cause instanceof Error ? cause.message : String(cause),
          "Check that the hook command is valid.",
        ),
    })
  }
}

export const StubHookRunnerLive = Layer.succeed(HookRunner, new StubHookRunner())
