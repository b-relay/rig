import { Context, Effect } from "effect"
import type { ServiceRunnerError } from "../schema/errors.js"

export interface HookRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface HookRunner {
  readonly runHook: (
    command: string,
    opts: { readonly workdir: string; readonly env: Readonly<Record<string, string>> },
  ) => Effect.Effect<HookRunResult, ServiceRunnerError>
}

export const HookRunner = Context.GenericTag<HookRunner>("HookRunner")
