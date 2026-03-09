import { Context, Effect } from "effect"
import type { ServiceRunnerError } from "../schema/errors.js"
import type { ServerService } from "../schema/config.js"

export interface RunOpts {
  readonly workdir: string
  readonly envVars: Readonly<Record<string, string>>
  readonly logDir: string
}

export interface RunningService {
  readonly name: string
  readonly pid: number
  readonly port: number
  readonly startedAt: Date
}

export type HealthStatus = "healthy" | "unhealthy" | "starting"

export interface LogOpts {
  readonly follow: boolean
  readonly lines: number
  readonly service?: string
  readonly workspacePath?: string
}

export interface ServiceRunner {
  readonly start: (
    service: ServerService,
    opts: RunOpts
  ) => Effect.Effect<RunningService, ServiceRunnerError>
  readonly stop: (
    service: RunningService
  ) => Effect.Effect<void, ServiceRunnerError>
  readonly health: (
    service: RunningService
  ) => Effect.Effect<HealthStatus, ServiceRunnerError>
  readonly logs: (
    service: string,
    opts: LogOpts
  ) => Effect.Effect<string, ServiceRunnerError>
}

export const ServiceRunner = Context.GenericTag<ServiceRunner>("ServiceRunner")
