import { Effect, Layer } from "effect"

import {
  ServiceRunner,
  type HealthStatus,
  type LogOpts,
  type RunOpts,
  type RunningService,
  type ServiceRunner as ServiceRunnerService,
} from "../interfaces/service-runner.js"
import type { ServerService } from "../schema/config.js"
import { ServiceRunnerError } from "../schema/errors.js"

const nextPid = (() => {
  let counter = 30000
  return () => {
    counter += 1
    return counter
  }
})()

export class StubServiceRunner implements ServiceRunnerService {
  private readonly running = new Map<string, RunningService>()

  start(service: ServerService, _opts: RunOpts): Effect.Effect<RunningService, ServiceRunnerError> {
    const active: RunningService = {
      name: service.name,
      pid: nextPid(),
      port: service.port,
      startedAt: new Date(),
    }

    this.running.set(service.name, active)
    return Effect.succeed(active)
  }

  stop(service: RunningService): Effect.Effect<void, ServiceRunnerError> {
    this.running.delete(service.name)
    return Effect.void
  }

  health(service: RunningService): Effect.Effect<HealthStatus, ServiceRunnerError> {
    return Effect.succeed(this.running.has(service.name) ? "healthy" : "unhealthy")
  }

  logs(service: string, opts: LogOpts): Effect.Effect<string, ServiceRunnerError> {
    if (!this.running.has(service)) {
      return Effect.fail(
        new ServiceRunnerError(
          "logs",
          service,
          `Service '${service}' is not running.`,
          "Start the service before requesting logs.",
        ),
      )
    }

    return Effect.succeed(
      `${service}: stub logs (lines=${opts.lines}, follow=${opts.follow}, serviceFilter=${opts.service ?? "all"})`,
    )
  }
}

export const StubServiceRunnerLive = Layer.succeed(ServiceRunner, new StubServiceRunner())
