import { Effect, Layer } from "effect"

import { runCli } from "./cli/index"
import { Logger } from "./interfaces/logger.js"
import { buildLoggerLayer } from "./provider-profiles.js"
import { BunBinInstallerLive } from "./providers/bun-bin"
import { BunHookRunnerLive } from "./providers/bun-hook-runner"
import { BunPortCheckerLive } from "./providers/bun-port-checker"
import { DotenvLoaderLive } from "./providers/dotenv-loader"
import { BunGitLive } from "./providers/bun-git"
import { BunServiceRunnerLive } from "./providers/bun-service-runner"
import { CaddyProxyLive } from "./providers/caddy"
import { DispatchHealthCheckerLive } from "./providers/health-checker-dispatch"
import { runInternalLogCapture } from "./providers/internal-log-capture"
import { NodeFileSystemLive } from "./providers/node-fs"
import { JSONRegistryLive } from "./providers/json-registry"
import { SmokeProcessManagerLive } from "./providers/smoke-process-manager"
import { CompositeLoggerLive } from "./providers/composite-logger"
import { FileLoggerLive } from "./providers/file-logger"
import { GitWorktreeWorkspaceLive } from "./providers/worktree"
import type { RigError } from "./schema/errors.js"

const normalizeArgv = (
  argv: readonly string[],
): {
  readonly argv: readonly string[]
  readonly verbose: boolean
  readonly json: boolean
} => {
  const filtered = argv.filter((arg) => arg !== "--verbose" && arg !== "--json")
  return {
    argv: filtered,
    verbose: argv.includes("--verbose"),
    json: argv.includes("--json"),
  }
}

const DotenvWithFileSystemLive = Layer.provide(DotenvLoaderLive, NodeFileSystemLive)
const RegistryWithFileSystemLive = Layer.provide(JSONRegistryLive, NodeFileSystemLive)
const BinInstallerWithFileSystemLive = Layer.provide(BunBinInstallerLive, NodeFileSystemLive)
const WorkspaceWithDependenciesLive = Layer.provide(
  GitWorktreeWorkspaceLive,
  Layer.mergeAll(BunGitLive, NodeFileSystemLive, RegistryWithFileSystemLive),
)

export const buildSmokeRigLayer = (verbose = false, json = false) => {
  const loggerLayer = buildLoggerLayer(verbose, json)
  const serviceRunnerWithFileSystemLive = Layer.provide(
    BunServiceRunnerLive,
    Layer.mergeAll(NodeFileSystemLive, loggerLayer),
  )

  return Layer.mergeAll(
    NodeFileSystemLive,
    DotenvWithFileSystemLive,
    RegistryWithFileSystemLive,
    BunGitLive,
    BunHookRunnerLive,
    BunPortCheckerLive,
    CaddyProxyLive,
    SmokeProcessManagerLive,
    WorkspaceWithDependenciesLive,
    DispatchHealthCheckerLive,
    serviceRunnerWithFileSystemLive,
    BinInstallerWithFileSystemLive,
    loggerLayer,
  )
}

const isRigError = (error: unknown): error is RigError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  "message" in error &&
  "hint" in error &&
  typeof error._tag === "string" &&
  typeof error.message === "string" &&
  typeof error.hint === "string"

const isTaggedMessageError = (error: unknown): error is { _tag: string; message: string } =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  "message" in error &&
  typeof error._tag === "string" &&
  typeof error.message === "string"

const stringifyUnknown = (value: unknown): string => {
  try {
    const serialized = JSON.stringify(value, null, 2)
    return serialized ?? String(value)
  } catch {
    return String(value)
  }
}

const renderUnexpectedErrorDetails = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }

  if (isTaggedMessageError(error)) {
    return {
      tag: error._tag,
      message: error.message,
    }
  }

  return {
    value: stringifyUnknown(error),
  }
}

export const main = (argv: string[]): Promise<number> =>
  argv[0] === "_capture-logs"
    ? runInternalLogCapture(argv.slice(1))
    : Effect.runPromise(
        (Effect.gen(function* () {
          const normalized = normalizeArgv(argv)

          return yield* runCli(normalized.argv).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const logger = yield* Logger

                if (isRigError(error)) {
                  yield* logger.error(error)
                } else {
                  yield* logger.warn(
                    "Unexpected error while running command.",
                    renderUnexpectedErrorDetails(error),
                  )
                }

                return 1
              }),
            ),
            Effect.provide(buildSmokeRigLayer(normalized.verbose, normalized.json) as never),
          )
        }) as Effect.Effect<number, never, never>),
      )

const handleSignal = (signal: string) => {
  console.error(`\n✗ Received ${signal}. Shutting down.`)
  process.exit(130)
}

process.on("SIGTERM", () => handleSignal("SIGTERM"))
process.on("SIGINT", () => handleSignal("SIGINT"))

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2))
  process.exitCode = exitCode
}
