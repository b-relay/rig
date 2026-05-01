import { Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"

import type { RigDeploymentRecord } from "../deployments.js"
import { platformMakeDirectory } from "../effect-platform.js"
import { RigRuntimeError } from "../errors.js"
import type {
  RigProviderOutputLine,
  RigProviderPlugin,
  RigProviderPluginForFamily,
  RigRuntimeServiceConfig,
} from "../provider-contracts.js"
import type {
  RigProcessSupervisorExitResult,
  RigProcessSupervisorOperationResult,
} from "./process-supervisor.js"

export const rigdProcessSupervisorProvider = {
  id: "rigd",
  family: "process-supervisor",
  source: "core",
  displayName: "rigd Core Supervisor",
  capabilities: ["core-supervisor", "session-processes", "same-provider-interface"],
} satisfies RigProviderPlugin

interface RigdProcessSupervisorInput {
  readonly deployment: RigDeploymentRecord
  readonly service: RigRuntimeServiceConfig
}

interface RigdManagedProcess {
  readonly handle: ChildProcessHandle
  readonly scope: Scope.Closeable
  stopping: boolean
}

export interface RigdProcessSupervisorAdapter {
  readonly up: (
    provider: RigProviderPluginForFamily<"process-supervisor">,
    input: RigdProcessSupervisorInput,
  ) => Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError>
  readonly down: (
    provider: RigProviderPluginForFamily<"process-supervisor">,
    input: RigdProcessSupervisorInput,
  ) => Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError>
  readonly restart: (
    provider: RigProviderPluginForFamily<"process-supervisor">,
    input: RigdProcessSupervisorInput,
  ) => Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError>
}

const RigdProcessLayer = Layer.provide(
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

const spawnRigdProcess = (
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
    Effect.provide(RigdProcessLayer),
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

const outputLines = (
  stream: RigProviderOutputLine["stream"],
  text: string,
): readonly RigProviderOutputLine[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => ({ stream, line }))

const outputText = (
  output: readonly RigProviderOutputLine[],
  stream: "stdout" | "stderr",
): string | undefined => {
  const text = output.filter((line) => line.stream === stream).map((line) => line.line).join("\n")
  return text.length > 0 ? text : undefined
}

const operationName = (
  provider: RigProviderPlugin,
  action: "up" | "down" | "restart",
  service: RigRuntimeServiceConfig,
  suffix?: string,
): string =>
  `${provider.family}:${provider.id}:${action}:${service.name}${suffix ? `:${suffix}` : ""}`

const processKey = (deployment: RigDeploymentRecord, service: RigRuntimeServiceConfig): string =>
  `${deployment.project}:${deployment.name}:${service.name}`

const runtimeError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new RigRuntimeError(
    message,
    hint,
    {
      cause: cause instanceof Error ? cause.message : String(cause),
      ...(details ?? {}),
    },
  )

export const createRigdProcessSupervisorAdapter = (): RigdProcessSupervisorAdapter => {
  const rigdProcesses = new Map<string, RigdManagedProcess>()

  const collectProcessOutput = (
    handle: ChildProcessHandle,
  ): Effect.Effect<readonly RigProviderOutputLine[], RigRuntimeError> =>
    Effect.all(
      [
        streamText(handle.stdout),
        streamText(handle.stderr),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([stdout, stderr]) => [
        ...outputLines("stdout", stdout),
        ...outputLines("stderr", stderr),
      ]),
      Effect.mapError((cause) =>
        new RigRuntimeError(
          "Unable to collect rig process output.",
          "Inspect the managed process streams and retry the runtime action.",
          {
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      ),
    )

  const watchRigdProcessExit = (
    key: string,
    running: RigdManagedProcess,
  ): Effect.Effect<RigProcessSupervisorExitResult, RigRuntimeError> =>
    Effect.gen(function* () {
      const exitCode = yield* running.handle.exitCode.pipe(
        Effect.map((code) => Number(code)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const output = yield* collectProcessOutput(running.handle)
      if (rigdProcesses.get(key) === running) {
        rigdProcesses.delete(key)
      }
      yield* Scope.close(running.scope, Exit.void).pipe(Effect.ignore)
      return {
        expected: running.stopping,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(outputText(output, "stdout") ? { stdout: outputText(output, "stdout") } : {}),
        ...(outputText(output, "stderr") ? { stderr: outputText(output, "stderr") } : {}),
      }
    })

  const stopRigdProcess = (
    provider: RigProviderPlugin,
    input: RigdProcessSupervisorInput,
  ): Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError> =>
    Effect.gen(function* () {
      const key = processKey(input.deployment, input.service)
      const running = rigdProcesses.get(key)
      if (!running) {
        return {
          operation: operationName(provider, "down", input.service, "not-running"),
        } satisfies RigProcessSupervisorOperationResult
      }

      rigdProcesses.delete(key)
      running.stopping = true
      yield* running.handle.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore)
      const exitCode = yield* running.handle.exitCode.pipe(
        Effect.map((code) => Number(code)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      yield* Scope.close(running.scope, Exit.void).pipe(Effect.ignore)
      return {
        operation: operationName(provider, "down", input.service, `stopped:${exitCode ?? "unknown"}`),
      } satisfies RigProcessSupervisorOperationResult
    }).pipe(
      Effect.mapError(runtimeError(
        `Unable to stop rigd-supervised process '${input.service.name}'.`,
        "Check the managed process state and retry the lifecycle action.",
        {
          providerId: provider.id,
          component: input.service.name,
          deployment: input.deployment.name,
        },
      )),
    )

  const startRigdProcess = (
    provider: RigProviderPlugin,
    action: "up" | "restart",
    input: RigdProcessSupervisorInput,
  ): Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError> => {
    if (!("command" in input.service)) {
      return Effect.fail(
        new RigRuntimeError(
          `Component '${input.service.name}' cannot be supervised by rigd.`,
          "Only managed server components with a command can use the rigd process supervisor.",
          {
            providerId: provider.id,
            component: input.service.name,
            deployment: input.deployment.name,
          },
        ),
      )
    }

    return Effect.gen(function* () {
      const key = processKey(input.deployment, input.service)
      if (action === "up" && rigdProcesses.has(key)) {
        return {
          operation: operationName(provider, action, input.service, "already-running"),
        } satisfies RigProcessSupervisorOperationResult
      }

      const existing = rigdProcesses.get(key)
      if (existing) {
        rigdProcesses.delete(key)
        existing.stopping = true
        yield* existing.handle.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore)
        yield* existing.handle.exitCode.pipe(Effect.ignore)
        yield* Scope.close(existing.scope, Exit.void).pipe(Effect.ignore)
      }

      yield* platformMakeDirectory(input.deployment.workspacePath).pipe(
        Effect.mapError((cause) =>
          new RigRuntimeError(
            `Unable to prepare workspace for '${input.service.name}'.`,
            "Ensure the deployment workspace is writable before starting the component.",
            {
              providerId: provider.id,
              component: input.service.name,
              deployment: input.deployment.name,
              workspacePath: input.deployment.workspacePath,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          ),
        ),
      )
      const scope = yield* Scope.make()
      const handle = yield* spawnRigdProcess(
        ["sh", "-lc", input.service.command],
        { cwd: input.deployment.workspacePath, scope },
      )
      const quickExit = yield* handle.exitCode.pipe(Effect.timeoutOption("50 millis"))

      if (Option.isNone(quickExit)) {
        const running = { handle, scope, stopping: false }
        rigdProcesses.set(key, running)
        return {
          operation: operationName(provider, action, input.service, "started"),
          exit: watchRigdProcessExit(key, running),
        } satisfies RigProcessSupervisorOperationResult
      }

      const exitCode = Number(quickExit.value)
      const output = yield* collectProcessOutput(handle)
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
      if (exitCode !== 0) {
        return yield* Effect.fail(new RigRuntimeError(
          `rigd process supervisor command failed for '${input.service.name}' with exit code ${exitCode}.`,
          "Fix the managed component command before retrying the lifecycle action.",
          {
            providerId: provider.id,
            component: input.service.name,
            deployment: input.deployment.name,
            command: input.service.command,
            exitCode,
            stdout: output.filter((line) => line.stream === "stdout").map((line) => line.line).join("\n"),
            stderr: output.filter((line) => line.stream === "stderr").map((line) => line.line).join("\n"),
          },
        ))
      }

      return {
        operation: operationName(provider, action, input.service, `exited:${exitCode}`),
        ...(output.length > 0 ? { output } : {}),
      } satisfies RigProcessSupervisorOperationResult
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof RigRuntimeError
          ? cause
          : new RigRuntimeError(
            `Unable to start rigd-supervised process '${input.service.name}'.`,
            "Ensure the command can run from the deployment workspace and retry.",
            {
              providerId: provider.id,
              component: input.service.name,
              deployment: input.deployment.name,
              command: input.service.command,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          )),
    )
  }

  return {
    up: (provider, input) => startRigdProcess(provider, "up", input),
    down: stopRigdProcess,
    restart: (provider, input) => startRigdProcess(provider, "restart", input),
  }
}
