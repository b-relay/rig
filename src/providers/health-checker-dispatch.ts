import { Effect, Layer } from "effect"

import {
  HealthChecker,
  type HealthCheckConfig,
  type HealthChecker as HealthCheckerService,
} from "../interfaces/health-checker.js"
import { CmdHealthChecker } from "./cmd-health.js"
import { HttpHealthChecker } from "./http-health.js"

export class DispatchHealthChecker implements HealthCheckerService {
  constructor(
    private readonly http: HealthCheckerService,
    private readonly command: HealthCheckerService,
  ) {}

  check(config: HealthCheckConfig) {
    return this.pick(config).check(config)
  }

  poll(config: HealthCheckConfig, interval: number, timeout: number) {
    return this.pick(config).poll(config, interval, timeout)
  }

  private pick(config: HealthCheckConfig): HealthCheckerService {
    switch (config.type) {
      case "http":
        return this.http
      case "command":
        return this.command
    }
  }
}

export const DispatchHealthCheckerLive = Layer.effect(
  HealthChecker,
  Effect.sync(
    () =>
      new DispatchHealthChecker(
        new HttpHealthChecker(),
        new CmdHealthChecker(),
      ),
  ),
)
