import { Context, Effect } from "effect"
import type { ProcessError } from "../schema/errors.js"

export interface DaemonConfig {
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  readonly keepAlive: boolean
  readonly envVars: Readonly<Record<string, string>>
  readonly workdir: string
  readonly logPath: string
}

export interface DaemonStatus {
  readonly label: string
  readonly running: boolean
  readonly pid: number | null
  readonly loaded: boolean
}

export interface ProcessManager {
  readonly install: (config: DaemonConfig) => Effect.Effect<void, ProcessError>
  readonly uninstall: (label: string) => Effect.Effect<void, ProcessError>
  readonly start: (label: string) => Effect.Effect<void, ProcessError>
  readonly stop: (label: string) => Effect.Effect<void, ProcessError>
  readonly status: (label: string) => Effect.Effect<DaemonStatus, ProcessError>
  readonly backup: (label: string) => Effect.Effect<string, ProcessError>
}

export const ProcessManager = Context.GenericTag<ProcessManager>("ProcessManager")
