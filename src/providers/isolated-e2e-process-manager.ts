import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect, Layer } from "effect-v3"

import { rigIsolatedE2ELaunchdBackupRoot, rigIsolatedE2EStatePath } from "../core/rig-paths.js"
import {
  ProcessManager,
  type DaemonConfig,
  type DaemonStatus,
  type ProcessManager as ProcessManagerService,
} from "../interfaces/process-manager.js"
import { ProcessError } from "../schema/errors.js"

interface PersistedDaemonState {
  readonly label: string
  readonly loaded: boolean
  readonly running: boolean
  readonly pid: number | null
}

interface PersistedState {
  readonly daemons: Readonly<Record<string, PersistedDaemonState>>
}

const STATE_PATH = () => rigIsolatedE2EStatePath()
const BACKUP_DIR = () => rigIsolatedE2ELaunchdBackupRoot()
const FAILURE_SPEC_ENV = "RIG_ISOLATED_E2E_PROCESS_FAIL"
const PID_BASE = 20_000

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const parseFailureSpec = (
  raw: string | undefined,
): ReadonlySet<string> => {
  if (!raw) {
    return new Set()
  }

  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeState = (raw: unknown): PersistedState => {
  if (!isObject(raw) || !isObject(raw.daemons)) {
    return { daemons: {} }
  }

  const daemons: Record<string, PersistedDaemonState> = {}

  for (const [label, value] of Object.entries(raw.daemons)) {
    if (!isObject(value)) {
      continue
    }

    daemons[label] = {
      label,
      loaded: value.loaded === true,
      running: value.running === true,
      pid: typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null,
    }
  }

  return { daemons }
}

const nextPid = (state: PersistedState): number => {
  const existing = Object.values(state.daemons)
    .map((daemon) => daemon.pid ?? 0)
    .filter((pid) => pid > 0)

  return Math.max(PID_BASE, ...existing) + 1
}

export class IsolatedE2EProcessManager implements ProcessManagerService {
  private readonly statePath: string
  private readonly backupDir: string
  private readonly failures: ReadonlySet<string>

  constructor(opts?: { readonly statePath?: string; readonly backupDir?: string }) {
    this.statePath = opts?.statePath ?? STATE_PATH()
    this.backupDir = opts?.backupDir ?? BACKUP_DIR()
    this.failures = parseFailureSpec(process.env[FAILURE_SPEC_ENV])
  }

  install(config: DaemonConfig): Effect.Effect<void, ProcessError> {
    return this.runMutation("install", config.label, async (state) => {
      const daemons = {
        ...state.daemons,
        [config.label]: {
          label: config.label,
          loaded: true,
          running: false,
          pid: null,
        },
      }

      return { daemons }
    })
  }

  uninstall(label: string): Effect.Effect<void, ProcessError> {
    return this.runMutation("uninstall", label, async (state) => {
      const daemons = { ...state.daemons }
      delete daemons[label]
      return { daemons }
    })
  }

  start(label: string): Effect.Effect<void, ProcessError> {
    return this.runMutation("spawn", label, async (state) => {
      const existing = state.daemons[label]
      const daemons = {
        ...state.daemons,
        [label]: {
          label,
          loaded: existing?.loaded ?? true,
          running: true,
          pid: nextPid(state),
        },
      }

      return { daemons }
    })
  }

  stop(label: string): Effect.Effect<void, ProcessError> {
    return this.runMutation("kill", label, async (state) => {
      const existing = state.daemons[label] ?? {
        label,
        loaded: false,
        running: false,
        pid: null,
      }

      const daemons = {
        ...state.daemons,
        [label]: {
          ...existing,
          running: false,
          pid: null,
        },
      }

      return { daemons }
    })
  }

  status(label: string): Effect.Effect<DaemonStatus, ProcessError> {
    return Effect.tryPromise({
      try: async () => {
        this.maybeFail("status", label)

        const state = await this.readState()
        return (
          state.daemons[label] ?? {
            label,
            loaded: false,
            running: false,
            pid: null,
          }
        )
      },
      catch: (cause) =>
        new ProcessError(
          "status",
          label,
          `Failed to read isolated e2e launchd state for ${label}: ${causeMessage(cause)}`,
          `Check isolated e2e process state at ${this.statePath}.`,
        ),
    })
  }

  backup(label: string): Effect.Effect<string, ProcessError> {
    return Effect.tryPromise({
      try: async () => {
        this.maybeFail("backup", label)

        await mkdir(this.backupDir, { recursive: true })
        const backupPath = join(this.backupDir, `${label}.plist`)
        await Bun.write(backupPath, `# isolated e2e launchd backup for ${label}\n`)
        return backupPath
      },
      catch: (cause) =>
        new ProcessError(
          "install",
          label,
          `Failed to write isolated e2e launchd backup for ${label}: ${causeMessage(cause)}`,
          `Check isolated e2e backup directory at ${this.backupDir}.`,
        ),
    })
  }

  private runMutation(
    operation: ProcessError["operation"],
    label: string,
    mutate: (state: PersistedState) => Promise<PersistedState>,
  ): Effect.Effect<void, ProcessError> {
    return Effect.tryPromise({
      try: async () => {
        this.maybeFail(operation, label)

        const current = await this.readState()
        const next = await mutate(current)
        await this.writeState(next)
      },
      catch: (cause) =>
        new ProcessError(
          operation,
          label,
          `Failed to update isolated e2e launchd state for ${label}: ${causeMessage(cause)}`,
          `Check isolated e2e process state at ${this.statePath}.`,
        ),
    })
  }

  private maybeFail(operation: string, label: string): void {
    if (
      this.failures.has(`${operation}:${label}`) ||
      this.failures.has(`${operation}:*`) ||
      this.failures.has("*")
    ) {
      throw new Error(`Injected isolated e2e process-manager failure for ${operation}:${label}`)
    }
  }

  private async readState(): Promise<PersistedState> {
    const file = Bun.file(this.statePath)
    const exists = await file.exists()
    if (!exists) {
      return { daemons: {} }
    }

    return normalizeState(JSON.parse(await file.text()) as unknown)
  }

  private async writeState(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true })
    await Bun.write(this.statePath, `${JSON.stringify(state, null, 2)}\n`)
  }
}

export const IsolatedE2EProcessManagerLive = Layer.succeed(ProcessManager, new IsolatedE2EProcessManager())
