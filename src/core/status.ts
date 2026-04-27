import { join } from "node:path"
import { Effect } from "effect-v3"

import { FileSystem } from "../interfaces/file-system.js"
import { Logger } from "../interfaces/logger.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { Registry } from "../interfaces/registry.js"
import { Workspace } from "../interfaces/workspace.js"
import type { StatusArgs } from "../schema/args.js"
import { CliArgumentError } from "../schema/errors.js"
import { loadProjectConfig, loadProjectConfigAtPath, resolveEnvironment } from "./config.js"
import { requireActiveProdWorkspace } from "./prod-state.js"
import { resolveProdReleaseState } from "./release-state.js"
import { daemonLabel } from "./shared.js"

interface PidEntry {
  readonly pid: number
  readonly port: number
  readonly startedAt: string
}

type PidMap = Record<string, PidEntry>

const parsePidMap = (raw: string): PidMap => {
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {}
  }

  const pids: PidMap = {}
  for (const [serviceName, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue
    }

    const entry = value as Record<string, unknown>
    if (
      typeof entry.pid !== "number" ||
      !Number.isInteger(entry.pid) ||
      entry.pid <= 0 ||
      typeof entry.port !== "number" ||
      !Number.isInteger(entry.port) ||
      entry.port <= 0 ||
      typeof entry.startedAt !== "string"
    ) {
      continue
    }

    pids[serviceName] = {
      pid: entry.pid,
      port: entry.port,
      startedAt: entry.startedAt,
    }
  }

  return pids
}

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : ""

    return code !== "ESRCH"
  }
}

const toUptimeSeconds = (startedAt: string): number | null => {
  const date = new Date(startedAt)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  return diff >= 0 ? diff : 0
}

export const runStatusCommand = (args: StatusArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const processManager = yield* ProcessManager
    const registry = yield* Registry

    if (!args.name) {
      const entries = yield* registry.list()
      const rows = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const releaseState = yield* resolveProdReleaseState(entry.name, entry.repoPath)
          const dev = yield* processManager.status(daemonLabel(entry.name, "dev")).pipe(
            Effect.catchAll(() =>
              Effect.succeed({
                label: daemonLabel(entry.name, "dev"),
                running: false,
                pid: null,
                loaded: false,
              }),
            ),
          )
          const prod = yield* processManager.status(daemonLabel(entry.name, "prod")).pipe(
            Effect.catchAll(() =>
              Effect.succeed({
                label: daemonLabel(entry.name, "prod"),
                running: false,
                pid: null,
                loaded: false,
              }),
            ),
          )

          return {
            name: entry.name,
            latestProdVersion: releaseState.latestProdVersion ?? "N/A",
            currentProdVersion: releaseState.currentProdVersion ?? "N/A",
            devRunning: dev.running,
            prodRunning: prod.running,
            repoPath: entry.repoPath,
          }
        }),
      )

      yield* logger.table(rows)
      return 0
    }

    const name = args.name
    const fileSystem = yield* FileSystem
    const workspace = yield* Workspace
    const project = yield* loadProjectConfig(name)
    const releaseState = yield* resolveProdReleaseState(name, project.repoPath)
    const envs = args.env ? [args.env] : (["dev", "prod"] as const)

    const rowSets = yield* Effect.forEach(envs, (env) => {
      const row = Effect.gen(function* () {
        const workspacePath = yield* workspace.resolve(name, env, env === "prod" ? args.version : undefined).pipe(
          Effect.catchTag("WorkspaceError", (error) =>
            logger.warn("Unable to resolve workspace for status.", {
              name,
              env,
              version: env === "prod" ? args.version : undefined,
              error: error.message,
            }).pipe(Effect.as(null)),
          ),
        )
        const loaded =
          env === "prod" && workspacePath
            ? yield* loadProjectConfigAtPath(name, workspacePath)
            : project
        if (env === "prod" && workspacePath) {
          const expectedVersion =
            args.version ??
            (yield* requireActiveProdWorkspace("status", name)).version
          if (loaded.config.version !== expectedVersion) {
            return yield* Effect.fail(
              new CliArgumentError(
                "status",
                `Active prod workspace '${expectedVersion}' for project '${name}' is inconsistent.`,
                `Repair or redeploy prod version '${expectedVersion}' before retrying. Workspace rig.json reports '${loaded.config.version}'.`,
                {
                  name,
                  env,
                  workspaceVersion: expectedVersion,
                  configVersion: loaded.config.version,
                  workspacePath,
                },
              ),
            )
          }
        }
        const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, env)
        const label = daemonLabel(name, env)
        const daemon = yield* processManager.status(label).pipe(
          Effect.catchAll(() =>
            Effect.succeed({
              label,
              loaded: false,
              running: false,
              pid: null,
            }),
          ),
        )
        const pidsPath = workspacePath ? join(workspacePath, ".rig", "pids.json") : null
        let pids: PidMap = {}

        if (pidsPath) {
          const exists = yield* fileSystem.exists(pidsPath).pipe(
            Effect.catchAll((error) =>
              logger.warn("Unable to check PID tracking file.", {
                path: pidsPath,
                error: error.message,
              }).pipe(Effect.as(false)),
            ),
          )

          if (exists) {
            const raw = yield* fileSystem.read(pidsPath).pipe(
              Effect.catchAll((error) =>
                logger.warn("Unable to read PID tracking file.", {
                  path: pidsPath,
                  error: error.message,
                }).pipe(Effect.as(null)),
              ),
            )

            if (raw !== null) {
              pids = yield* Effect.try({
                try: () => parsePidMap(raw),
                catch: (cause) => cause,
              }).pipe(
                Effect.catchAll((cause) =>
                  logger.warn("Invalid PID tracking file; ignoring service status.", {
                    path: pidsPath,
                    error: causeMessage(cause),
                  }).pipe(Effect.as({} as PidMap)),
                ),
              )
            }
          }
        }

        const base = {
          name,
          env,
          latestProdVersion: releaseState.latestProdVersion ?? "N/A",
          currentProdVersion: releaseState.currentProdVersion ?? "N/A",
          ...(env === "prod" ? { version: loaded.config.version } : {}),
          services: environment.services.length,
          daemonLoaded: daemon.loaded,
          daemonRunning: daemon.running,
          daemonPid: daemon.pid,
        }

        const serviceRows = Object.entries(pids).map(([service, entry]) => ({
          ...base,
          service,
          pid: entry.pid,
          port: entry.port,
          alive: isProcessAlive(entry.pid),
          startedAt: entry.startedAt,
          uptimeSeconds: toUptimeSeconds(entry.startedAt),
        }))

        if (serviceRows.length > 0) {
          return serviceRows
        }

        return [
          {
            ...base,
            service: null,
            pid: null,
            port: null,
            alive: null,
            startedAt: null,
            uptimeSeconds: null,
          },
        ]
      })

      if (args.env) {
        return row
      }

      return row.pipe(
        Effect.catchTag("ConfigValidationError", () => Effect.succeed([] as readonly Record<string, unknown>[])),
      )
    })

    const rows = rowSets.flatMap((set) => set)

    yield* logger.table(rows)
    return 0
  })
