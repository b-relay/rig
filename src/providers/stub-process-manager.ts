import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Layer } from "effect"

import {
  ProcessManager,
  type DaemonConfig,
  type DaemonStatus,
  type ProcessManager as ProcessManagerService,
} from "../interfaces/process-manager.js"
import type { ProcessError } from "../schema/errors.js"

const nextPid = (() => {
  let counter = 9000
  return () => {
    counter += 1
    return counter
  }
})()

export class StubProcessManager implements ProcessManagerService {
  private readonly states = new Map<string, DaemonStatus>()

  install(config: DaemonConfig): Effect.Effect<void, ProcessError> {
    this.states.set(config.label, {
      label: config.label,
      loaded: true,
      running: false,
      pid: null,
    })

    return Effect.void
  }

  uninstall(label: string): Effect.Effect<void, ProcessError> {
    this.states.delete(label)
    return Effect.void
  }

  start(label: string): Effect.Effect<void, ProcessError> {
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
    return Effect.succeed(join(tmpdir(), `${label}-launchd-backup.plist`))
  }
}

export const StubProcessManagerLive = Layer.succeed(ProcessManager, new StubProcessManager())
