import { Effect, Layer } from "effect"

import {
  PortChecker,
  type PortChecker as PortCheckerService,
} from "../interfaces/port-checker.js"

/**
 * Stub that always reports ports as available.
 * Used in tests where real port binding is not desired.
 */
class StubPortChecker implements PortCheckerService {
  check(_port: number, _service: string) {
    return Effect.void
  }
}

export const StubPortCheckerLive = Layer.succeed(PortChecker, new StubPortChecker())
