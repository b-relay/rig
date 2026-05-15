import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"

import {
  isPlatformNotFound,
  platformExists,
  platformMakeDirectory,
  platformReadFileString,
  platformRemove,
  platformWriteFileString,
} from "./effect-platform.js"
import { RigRuntimeError } from "./errors.js"
import { RigdStateStore } from "./rigd-state.js"

export interface RigdDaemonAdminInput {
  readonly stateRoot: string
}

export interface RigdDaemonInstallResult {
  readonly stateRoot: string
  readonly installed: true
  readonly running: true
  readonly reachable: true
  readonly tokenPath: string
  readonly tokenCreated: boolean
  readonly daemonStatePath: string
}

export interface RigdDaemonStatusResult {
  readonly stateRoot: string
  readonly installed: boolean
  readonly running: boolean
  readonly reachable: boolean
  readonly tokenPath: string
  readonly tokenPresent: boolean
  readonly daemonStatePath: string
}

export interface RigdDaemonUninstallResult {
  readonly stateRoot: string
  readonly installed: false
  readonly removed: true
  readonly tokenPath: string
  readonly daemonStatePath: string
}

export interface RigdDaemonAdminService {
  readonly install: (
    input: RigdDaemonAdminInput,
  ) => Effect.Effect<RigdDaemonInstallResult, RigRuntimeError>
  readonly status: (
    input: RigdDaemonAdminInput,
  ) => Effect.Effect<RigdDaemonStatusResult, RigRuntimeError>
  readonly uninstall: (
    input: RigdDaemonAdminInput,
  ) => Effect.Effect<RigdDaemonUninstallResult, RigRuntimeError>
}

export const RigdDaemonAdmin =
  Context.Service<RigdDaemonAdminService>("rig/rig/RigdDaemonAdmin")

const authRoot = (stateRoot: string) => join(stateRoot, "auth")
const tokenPath = (stateRoot: string) => join(authRoot(stateRoot), "control-plane.token")
const daemonRoot = (stateRoot: string) => join(stateRoot, "daemon")
const daemonStatePath = (stateRoot: string) => join(daemonRoot(stateRoot), "rigd.json")

const adminError = (
  message: string,
  hint: string,
  details: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new RigRuntimeError(
    message,
    hint,
    {
      ...details,
      cause: cause instanceof Error ? cause.message : String(cause),
    },
  )

const readToken = (stateRoot: string) =>
  platformReadFileString(tokenPath(stateRoot)).pipe(
    Effect.matchEffect({
      onSuccess: (token) => Effect.succeed(token),
      onFailure: (cause) => isPlatformNotFound(cause) ? Effect.succeed(undefined) : Effect.fail(cause),
    }),
    Effect.mapError(adminError(
      "Unable to read rigd local auth token.",
      "Check permissions for the rig auth directory, then retry rigd status.",
      { stateRoot, tokenPath: tokenPath(stateRoot) },
    )),
  )

const ensureToken = (stateRoot: string) =>
  Effect.gen(function* () {
    const existing = yield* readToken(stateRoot)
    if (existing?.trim()) {
      return false
    }

    yield* platformMakeDirectory(authRoot(stateRoot))
    yield* platformWriteFileString(tokenPath(stateRoot), `${randomBytes(32).toString("base64url")}\n`)
    return true
  }).pipe(
    Effect.mapError(adminError(
      "Unable to create rigd local auth token.",
      "Check permissions for the rig auth directory, then retry rigd install.",
      { stateRoot, tokenPath: tokenPath(stateRoot) },
    )),
  )

const writeDaemonState = (stateRoot: string) =>
  Effect.gen(function* () {
    yield* platformMakeDirectory(daemonRoot(stateRoot))
    yield* platformWriteFileString(
      daemonStatePath(stateRoot),
      `${JSON.stringify({
        version: 1,
        installedAt: new Date().toISOString(),
        mode: "localhost",
        launchd: {
          managedBy: "rigd install",
          status: "installed",
        },
        controlPlane: {
          bindHost: "127.0.0.1",
          authTokenPath: tokenPath(stateRoot),
        },
      }, null, 2)}\n`,
    )
  }).pipe(
    Effect.mapError(adminError(
      "Unable to write rigd daemon state.",
      "Check permissions for the rig daemon directory, then retry rigd install.",
      { stateRoot, daemonStatePath: daemonStatePath(stateRoot) },
    )),
  )

const runningTargets = (stateRoot: string) =>
  Effect.gen(function* () {
    const stateStore = yield* RigdStateStore
    const state = yield* stateStore.load({ stateRoot })
    return state.desiredDeployments.filter((deployment) => deployment.desiredStatus === "running")
  })

export const RigdDaemonAdminLive = Layer.effect(
  RigdDaemonAdmin,
  Effect.gen(function* () {
    return {
      install: (input) =>
        Effect.gen(function* () {
          const tokenCreated = yield* ensureToken(input.stateRoot)
          yield* writeDaemonState(input.stateRoot)
          return {
            stateRoot: input.stateRoot,
            installed: true,
            running: true,
            reachable: true,
            tokenPath: tokenPath(input.stateRoot),
            tokenCreated,
            daemonStatePath: daemonStatePath(input.stateRoot),
          }
        }),
      status: (input) =>
        Effect.gen(function* () {
          const installed = yield* platformExists(daemonStatePath(input.stateRoot)).pipe(
            Effect.mapError(adminError(
              "Unable to inspect rigd daemon state.",
              "Check permissions for the rig daemon directory, then retry rigd status.",
              { stateRoot: input.stateRoot, daemonStatePath: daemonStatePath(input.stateRoot) },
            )),
          )
          const token = yield* readToken(input.stateRoot)
          const tokenPresent = Boolean(token?.trim())
          return {
            stateRoot: input.stateRoot,
            installed,
            running: installed,
            reachable: installed && tokenPresent,
            tokenPath: tokenPath(input.stateRoot),
            tokenPresent,
            daemonStatePath: daemonStatePath(input.stateRoot),
          }
        }),
      uninstall: (input) =>
        Effect.gen(function* () {
          const running = yield* runningTargets(input.stateRoot)
          if (running.length > 0) {
            return yield* Effect.fail(
              new RigRuntimeError(
                "Cannot uninstall rigd while Rig Targets are running.",
                "Run rig down for running Targets, then retry rigd uninstall.",
                {
                  stateRoot: input.stateRoot,
                  runningTargets: running.map((target) => ({
                    project: target.project,
                    deployment: target.deployment,
                    kind: target.kind,
                  })),
                },
              ),
            )
          }
          yield* platformRemove(daemonRoot(input.stateRoot), { recursive: true, force: true }).pipe(
            Effect.mapError(adminError(
              "Unable to remove rigd daemon state.",
              "Check permissions for the rig daemon directory, then retry rigd uninstall.",
              { stateRoot: input.stateRoot, daemonStatePath: daemonStatePath(input.stateRoot) },
            )),
          )
          yield* platformRemove(tokenPath(input.stateRoot), { force: true }).pipe(
            Effect.mapError(adminError(
              "Unable to remove rigd local auth token.",
              "Check permissions for the rig auth directory, then retry rigd uninstall.",
              { stateRoot: input.stateRoot, tokenPath: tokenPath(input.stateRoot) },
            )),
          )
          return {
            stateRoot: input.stateRoot,
            installed: false,
            removed: true,
            tokenPath: tokenPath(input.stateRoot),
            daemonStatePath: daemonStatePath(input.stateRoot),
          }
        }),
    } satisfies RigdDaemonAdminService
  }),
)

