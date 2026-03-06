import { Context, Effect } from "effect"
import type { PortConflictError, ServiceRunnerError } from "../schema/errors.js"

// Checks whether a TCP port is available for binding on 127.0.0.1.
export interface PortChecker {
  readonly check: (
    port: number,
    service: string,
  ) => Effect.Effect<void, PortConflictError | ServiceRunnerError>
}

export const PortChecker = Context.GenericTag<PortChecker>("PortChecker")
