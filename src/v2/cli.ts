import { Effect, FileSystem, Layer, Path, Sink, Stdio, Stream, Terminal } from "effect-v4"
import { Command, Flag } from "effect-v4/unstable/cli"
import { ChildProcessSpawner } from "effect-v4/unstable/process/ChildProcessSpawner"

import { decodeV2StatusInput } from "./config.js"
import { V2CliArgumentError, unknownToV2CliError } from "./errors.js"
import { V2Lifecycle, type V2LifecycleAction, type V2LifecycleLane } from "./lifecycle.js"
import { rigV2Root } from "./paths.js"
import { V2ProjectLocator } from "./project-locator.js"
import { V2Logger, V2Runtime } from "./services.js"

const terminal = Terminal.make({
  columns: Effect.succeed(100),
  readInput: Effect.die("rig2 foundation CLI does not read terminal input yet."),
  readLine: Effect.succeed(""),
  display: (text) => Effect.promise(() => Bun.write(Bun.stdout, text).then(() => undefined)),
})

const childProcessSpawner = ChildProcessSpawner.of({
  spawn: () => Effect.die("rig2 foundation CLI does not spawn child processes yet."),
  exitCode: () => Effect.die("rig2 foundation CLI does not spawn child processes yet."),
  streamString: () => Stream.empty,
  streamLines: () => Stream.empty,
  lines: () => Effect.succeed([]),
  string: () => Effect.succeed(""),
})

const cliEnvironmentLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Layer.succeed(Terminal.Terminal, terminal),
  Stdio.layerTest({
    args: Effect.succeed([]),
    stdin: Stream.empty,
    stdout: () => Sink.drain,
    stderr: () => Sink.drain,
  }),
  Layer.succeed(ChildProcessSpawner, childProcessSpawner),
)

interface ProjectScopedInput {
  readonly project: string
  readonly lane: V2LifecycleLane
  readonly stateRoot: string
}

const projectFlag = Flag.string("project").pipe(
  Flag.withDefault(""),
  Flag.withDescription("Registered project name. Optional inside a managed repo."),
)

const laneFlag = Flag.choice("lane", ["local", "live"]).pipe(
  Flag.withDefault("local" as const),
  Flag.withDescription("V2 runtime lane: local working copy or live built deployment."),
)

const stateRootFlag = Flag.string("state-root").pipe(
  Flag.withDefault(rigV2Root()),
  Flag.withDescription("Isolated v2 state root. Defaults to ~/.rig-v2."),
)

const resolveProjectScopedInput = (input: {
  readonly project: string
  readonly lane: V2LifecycleLane
  readonly stateRoot: string
}): Effect.Effect<ProjectScopedInput, V2CliArgumentError, V2ProjectLocator> =>
  Effect.gen(function* () {
    const explicitProject = input.project.trim()
    if (explicitProject.length > 0) {
      return {
        ...input,
        project: explicitProject,
      }
    }

    const locator = yield* V2ProjectLocator
    const located = yield* locator.inferCurrentProject

    return {
      ...input,
      project: located.name,
    }
  })

const runLifecycleAction = (
  action: V2LifecycleAction,
  input: {
    readonly project: string
    readonly lane: V2LifecycleLane
    readonly stateRoot: string
    readonly follow?: boolean
    readonly lines?: number
  },
) =>
  Effect.gen(function* () {
    const decoded = yield* decodeV2StatusInput({
      project: input.project,
      stateRoot: input.stateRoot,
    })
    const lifecycle = yield* V2Lifecycle
    yield* lifecycle.run({
      action,
      project: decoded.project,
      lane: input.lane,
      stateRoot: decoded.stateRoot,
      ...(input.follow !== undefined ? { follow: input.follow } : {}),
      ...(input.lines !== undefined ? { lines: input.lines } : {}),
    })
  })

const lifecycleCommand = (action: V2LifecycleAction, description: string) =>
  Command.make(
    action,
    {
      project: projectFlag,
      lane: laneFlag,
      stateRoot: stateRootFlag,
    },
    (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveProjectScopedInput(input)
        yield* runLifecycleAction(action, resolved)
      }),
  ).pipe(Command.withDescription(description))

const logsCommand = Command.make(
  "logs",
  {
    project: projectFlag,
    lane: laneFlag,
    stateRoot: stateRootFlag,
    follow: Flag.boolean("follow").pipe(Flag.withDescription("Follow log output.")),
    lines: Flag.integer("lines").pipe(
      Flag.withDefault(50),
      Flag.withDescription("Number of log lines to read."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const resolved = yield* resolveProjectScopedInput(input)
      yield* runLifecycleAction("logs", {
        ...resolved,
        follow: input.follow,
        lines: input.lines,
      })
    }),
).pipe(Command.withDescription("Inspect logs for a v2 local or live lane."))

const downCommand = Command.make(
  "down",
  {
    project: projectFlag,
    lane: laneFlag,
    stateRoot: stateRootFlag,
    destroy: Flag.boolean("destroy").pipe(
      Flag.withDescription("Reserved for generated deployment teardown; rejected for local/live lanes."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      if (input.destroy) {
        return yield* Effect.fail(
          new V2CliArgumentError(
            "down --destroy is reserved for generated deployments.",
            "Use plain 'rig2 down' for local/live lanes until generated deployments are available.",
            { lane: input.lane },
          ),
        )
      }

      const resolved = yield* resolveProjectScopedInput(input)
      yield* runLifecycleAction("down", resolved)
    }),
).pipe(Command.withDescription("Stop a v2 local or live lane."))

const statusCommand = Command.make(
  "status",
  {
    project: projectFlag,
    lane: laneFlag,
    stateRoot: stateRootFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const scoped = yield* resolveProjectScopedInput(input)
      const decoded = yield* decodeV2StatusInput(scoped)
      const runtime = yield* V2Runtime
      const logger = yield* V2Logger
      const state = yield* runtime.describeFoundation(decoded)

      yield* logger.info("rig2 foundation ready", {
        ...state,
        lane: scoped.lane,
      })
      yield* runLifecycleAction("status", scoped)
    }),
).pipe(
  Command.withDescription("Inspect the isolated v2 runtime foundation."),
)

const rig2Command = Command.make("rig2").pipe(
  Command.withDescription("Experimental rig v2 entrypoint."),
  Command.withSubcommands([
    lifecycleCommand("up", "Start a v2 local or live lane."),
    downCommand,
    logsCommand,
    statusCommand,
  ]),
)

export const runRig2Cli = (argv: readonly string[]) =>
  Command.runWith(rig2Command, { version: "0.0.0-v2" })(argv).pipe(
    Effect.as(0),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const logger = yield* V2Logger
        yield* logger.error(unknownToV2CliError(error))
        return 1
      }),
    ),
    Effect.provide(cliEnvironmentLayer),
  )
