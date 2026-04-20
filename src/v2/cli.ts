import { Effect, FileSystem, Layer, Path, Sink, Stdio, Stream, Terminal } from "effect-v4"
import { Command, Flag } from "effect-v4/unstable/cli"
import { ChildProcessSpawner } from "effect-v4/unstable/process/ChildProcessSpawner"

import { decodeV2StatusInput } from "./config.js"
import { unknownToV2CliError } from "./errors.js"
import { rigV2Root } from "./paths.js"
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

const statusCommand = Command.make(
  "status",
  {
    project: Flag.string("project").pipe(
      Flag.withDescription("Registered project name. Required outside a managed repo."),
    ),
    stateRoot: Flag.string("state-root").pipe(
      Flag.withDefault(rigV2Root()),
      Flag.withDescription("Isolated v2 state root. Defaults to ~/.rig-v2."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const decoded = yield* decodeV2StatusInput(input)
      const runtime = yield* V2Runtime
      const logger = yield* V2Logger
      const state = yield* runtime.describeFoundation(decoded)

      yield* logger.info("rig2 foundation ready", state)
    }),
).pipe(
  Command.withDescription("Inspect the isolated v2 runtime foundation."),
)

const rig2Command = Command.make("rig2").pipe(
  Command.withDescription("Experimental rig v2 entrypoint."),
  Command.withSubcommands([statusCommand]),
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
