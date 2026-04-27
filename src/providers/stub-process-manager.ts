import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Layer } from "effect-v3"

import {
  ProcessManager,
  type DaemonConfig,
  type DaemonStatus,
  type ProcessManager as ProcessManagerService,
} from "../interfaces/process-manager.js"
import { ProcessError } from "../schema/errors.js"

const nextPid = (() => {
  let counter = 9000
  return () => {
    counter += 1
    return counter
  }
})()

interface StubProcessManagerOptions {
  readonly initialStates?: readonly DaemonStatus[]
  readonly installFailures?: Readonly<Record<string, ProcessError>>
  readonly uninstallFailures?: Readonly<Record<string, ProcessError>>
  readonly startFailures?: Readonly<Record<string, ProcessError>>
  readonly stopFailures?: Readonly<Record<string, ProcessError>>
  readonly statusFailures?: Readonly<Record<string, ProcessError>>
  readonly backupFailures?: Readonly<Record<string, ProcessError>>
}

export class StubProcessManager implements ProcessManagerService {
  private readonly states = new Map<string, DaemonStatus>()
  readonly installCalls: DaemonConfig[] = []
  readonly uninstallCalls: string[] = []
  readonly startCalls: string[] = []
  readonly stopCalls: string[] = []
  readonly statusCalls: string[] = []
  readonly backupCalls: string[] = []

  constructor(private readonly options: StubProcessManagerOptions = {}) {
    for (const state of options.initialStates ?? []) {
      this.states.set(state.label, state)
    }
  }

  install(config: DaemonConfig): Effect.Effect<void, ProcessError> {
    this.installCalls.push(config)
    const failure = this.options.installFailures?.[config.label]
    if (failure) {
      return Effect.fail(failure)
    }

    this.states.set(config.label, {
      label: config.label,
      loaded: true,
      running: false,
      pid: null,
    })

    return Effect.void
  }

  uninstall(label: string): Effect.Effect<void, ProcessError> {
    this.uninstallCalls.push(label)
    const failure = this.options.uninstallFailures?.[label]
    if (failure) {
      return Effect.fail(failure)
    }

    this.states.delete(label)
    return Effect.void
  }

  start(label: string): Effect.Effect<void, ProcessError> {
    this.startCalls.push(label)
    const failure = this.options.startFailures?.[label]
    if (failure) {
      return Effect.fail(failure)
    }

    const previous = this.states.get(label)
    this.states.set(label, {
      label,
      loaded: previous?.loaded ?? true,
      running: true,
      pid: nextPid(),
    })

    return Effect.void
  }

  stop(label: string): Effect.Effect<void, ProcessError> {
    this.stopCalls.push(label)
    const failure = this.options.stopFailures?.[label]
    if (failure) {
      return Effect.fail(failure)
    }

    const previous = this.states.get(label)
    this.states.set(label, {
      label,
      loaded: previous?.loaded ?? true,
      running: false,
      pid: null,
    })

    return Effect.void
  }

  status(label: string): Effect.Effect<DaemonStatus, ProcessError> {
    this.statusCalls.push(label)
    const failure = this.options.statusFailures?.[label]
    if (failure) {
      return Effect.fail(failure)
    }

    return Effect.succeed(
      this.states.get(label) ?? {
        label,
        loaded: false,
        running: false,
        pid: null,
      },
    )
  }

  backup(label: string): Effect.Effect<string, ProcessError> {
    this.backupCalls.push(label)
    const failure = this.options.backupFailures?.[label]
    if (failure) {
      return Effect.fail(failure)
    }

    return Effect.succeed(join(tmpdir(), `${label}-launchd-backup.plist`))
  }

  stateFor(label: string): DaemonStatus | undefined {
    return this.states.get(label)
  }
}

export const StubProcessManagerLive = Layer.succeed(ProcessManager, new StubProcessManager())
