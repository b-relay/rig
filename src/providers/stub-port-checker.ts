import { Effect, Layer } from "effect"

import {
  PortChecker,
  type PortChecker as PortCheckerService,
} from "../interfaces/port-checker.js"
import { PortConflictError } from "../schema/errors.js"

interface StubPortConflict {
  readonly port: number
  readonly service?: string
  readonly existingPid?: number | null
  readonly message?: string
  readonly hint?: string
}

interface StubPortCheckerOptions {
  readonly conflicts?: readonly StubPortConflict[]
}

// Stub PortChecker for tests, with optional configured port conflicts.
export class StubPortChecker implements PortCheckerService {
  readonly checks: Array<{ readonly port: number; readonly service: string }> = []
  private readonly conflicts: readonly StubPortConflict[]

  constructor(options: StubPortCheckerOptions = {}) {
    this.conflicts = options.conflicts ?? []
  }

  check(port: number, service: string) {
    this.checks.push({ port, service })
    const conflict = this.conflicts.find(
      (entry) => entry.port === port && (entry.service === undefined || entry.service === service),
    )
    if (conflict) {
      return Effect.fail(
        new PortConflictError(
          port,
          service,
          conflict.existingPid ?? null,
          conflict.message ?? `Port ${port} is already in use.`,
          conflict.hint ?? "Stop the conflicting process or change the service port.",
        ),
      )
    }

    return Effect.void
  }
}

export const StubPortCheckerLive = Layer.succeed(PortChecker, new StubPortChecker())
