import { Effect, Layer } from "effect-v3"

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

interface StubServiceRunnerOptions {
  readonly startFailures?: Readonly<Record<string, ServiceRunnerError>>
  readonly stopFailures?: Readonly<Record<string, ServiceRunnerError>>
  readonly logFailures?: Readonly<Record<string, ServiceRunnerError>>
}

export class StubServiceRunner implements ServiceRunnerService {
  private readonly running = new Map<string, RunningService>()
  private sequence = 0
  readonly startCalls: Array<{ readonly sequence: number; readonly service: string; readonly opts: RunOpts }> = []
  readonly stopCalls: Array<{ readonly sequence: number; readonly service: string; readonly pid: number }> = []

  constructor(private readonly options: StubServiceRunnerOptions = {}) {}

  start(service: ServerService, opts: RunOpts): Effect.Effect<RunningService, ServiceRunnerError> {
    const startFailure = this.options.startFailures?.[service.name]
    if (startFailure) {
      return Effect.fail(startFailure)
    }

    const active: RunningService = {
      name: service.name,
      pid: nextPid(),
      port: service.port,
      startedAt: new Date(),
    }

    this.sequence += 1
    this.startCalls.push({
      sequence: this.sequence,
      service: service.name,
      opts,
    })
    this.running.set(service.name, active)
    return Effect.succeed(active)
  }

  stop(service: RunningService): Effect.Effect<void, ServiceRunnerError> {
    const stopFailure = this.options.stopFailures?.[service.name]
    if (stopFailure) {
      return Effect.fail(stopFailure)
    }

    this.sequence += 1
    this.stopCalls.push({
      sequence: this.sequence,
      service: service.name,
      pid: service.pid,
    })
    this.running.delete(service.name)
    return Effect.void
  }

  health(service: RunningService): Effect.Effect<HealthStatus, ServiceRunnerError> {
    return Effect.succeed(this.running.has(service.name) ? "healthy" : "unhealthy")
  }

  logs(service: string, opts: LogOpts): Effect.Effect<string, ServiceRunnerError> {
    const logFailure = this.options.logFailures?.[service]
    if (logFailure) {
      return Effect.fail(logFailure)
    }

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

  runningSnapshot(): readonly RunningService[] {
    return Array.from(this.running.values())
  }
}

export const StubServiceRunnerLive = Layer.succeed(ServiceRunner, new StubServiceRunner())
