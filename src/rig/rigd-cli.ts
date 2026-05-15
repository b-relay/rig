import { Effect, FileSystem, Layer, Path, Sink, Stdio, Stream, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { BunStdio } from "@effect/platform-bun"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import { RigdDaemonAdmin } from "./daemon-admin.js"
import { unknownToRigCliError } from "./errors.js"
import { rigRoot } from "./paths.js"
import { RigLogger } from "./services.js"

const displayText = (text: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), stdio.stdout({ endOnDone: false }))
  }).pipe(
    Effect.provide(BunStdio.layer),
    Effect.orDie,
  )

const terminal = Terminal.make({
  columns: Effect.succeed(100),
  readInput: Effect.die("rigd CLI does not read terminal input yet."),
  readLine: Effect.succeed(""),
  display: displayText,
})

const childProcessSpawner = ChildProcessSpawner.of({
  spawn: () => Effect.die("rigd CLI does not spawn child processes yet."),
  exitCode: () => Effect.die("rigd CLI does not spawn child processes yet."),
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

const installCommand = Command.make(
  "install",
  {},
  () =>
    Effect.gen(function* () {
      const admin = yield* RigdDaemonAdmin
      const logger = yield* RigLogger
      const installed = yield* admin.install({ stateRoot: rigRoot() })
      yield* logger.info("rigd installed", installed)
    }),
).pipe(Command.withDescription("Install and start the local rigd daemon."))

const statusCommand = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function* () {
      const admin = yield* RigdDaemonAdmin
      const logger = yield* RigLogger
      const status = yield* admin.status({ stateRoot: rigRoot() })
      yield* logger.info("rigd daemon status", status)
    }),
).pipe(Command.withDescription("Report daemon installation, running, and reachability state."))

const uninstallCommand = Command.make(
  "uninstall",
  {},
  () =>
    Effect.gen(function* () {
      const admin = yield* RigdDaemonAdmin
      const logger = yield* RigLogger
      const uninstalled = yield* admin.uninstall({ stateRoot: rigRoot() })
      yield* logger.info("rigd uninstalled", uninstalled)
    }),
).pipe(Command.withDescription("Uninstall daemon admin artifacts after Targets are stopped."))

const rigdCommand = Command.make("rigd").pipe(
  Command.withDescription("Rig daemon administration."),
  Command.withSubcommands([
    installCommand,
    statusCommand,
    uninstallCommand,
  ]),
)

export const runRigdCli = (argv: readonly string[]) =>
  Command.runWith(rigdCommand, { version: "0.0.0-rig" })(argv).pipe(
    Effect.as(0),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const logger = yield* RigLogger
        yield* logger.error(unknownToRigCliError(error))
        return 1
      }),
    ),
    Effect.provide(cliEnvironmentLayer),
  )

