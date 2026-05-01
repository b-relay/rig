import { Effect, Exit, Layer, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun"

import { RigRuntimeError } from "./errors.js"

export interface RigProviderCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type RigProviderCommandRunner = (args: readonly string[]) => Promise<RigProviderCommandResult>

const RigPlatformProcessLayer = Layer.provide(
  BunChildProcessSpawner.layer,
  Layer.merge(BunFileSystem.layer, BunPath.layer),
)

const streamText = (stream: Stream.Stream<Uint8Array, unknown, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runCollect,
    Effect.map((chunks) => chunks.join("")),
  )

const childProcessCommand = (
  args: readonly string[],
  options: {
    readonly cwd?: string
  } = {},
) => {
  const command = args[0]
  if (!command) {
    return Effect.fail(
      new RigRuntimeError(
        "Unable to run an empty command.",
        "Pass a command with at least one argument before invoking the rig process runner.",
      ),
    )
  }

  return Effect.succeed(
    ChildProcess.make(command, args.slice(1), {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
}

const spawnPlatformProcess = (
  args: readonly string[],
  options: {
    readonly cwd?: string
    readonly scope: Scope.Scope
  },
): Effect.Effect<ChildProcessHandle, RigRuntimeError> =>
  Effect.gen(function* () {
    const command = yield* childProcessCommand(args, options)
    return yield* command
  }).pipe(
    Scope.provide(options.scope),
    Effect.provide(RigPlatformProcessLayer),
    Effect.mapError((cause) =>
      cause instanceof RigRuntimeError
        ? cause
        : new RigRuntimeError(
          "Unable to spawn rig platform process.",
          "Ensure the command exists and the working directory is accessible.",
          {
            command: args.join(" "),
            ...(options.cwd ? { cwd: options.cwd } : {}),
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
    ),
  )

export const runPlatformCommand = (
  args: readonly string[],
  options: {
    readonly cwd?: string
  } = {},
): Effect.Effect<RigProviderCommandResult, RigRuntimeError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const handle = yield* spawnPlatformProcess(args, { ...options, scope })
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        streamText(handle.stdout),
        streamText(handle.stderr),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    )
    yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
    return { stdout, stderr, exitCode: Number(exitCode) }
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      cause instanceof RigRuntimeError
        ? cause
        : new RigRuntimeError(
          "Unable to run rig platform command.",
          "Ensure the command exists and the working directory is accessible.",
          {
            command: args.join(" "),
            ...(options.cwd ? { cwd: options.cwd } : {}),
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
    ),
  )

export const defaultCommandRunner: RigProviderCommandRunner = (args) =>
  Effect.runPromise(runPlatformCommand(args))
