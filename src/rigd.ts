import { Effect, Layer } from "effect"

import { RigdDaemonAdminLive } from "./rig/daemon-admin.js"
import { runRigdCli } from "./rig/rigd-cli.js"
import { RigRuntimeError } from "./rig/errors.js"
import { RigLive, RigLogger, RigLoggerLive } from "./rig/services.js"

const RigdAdminLive = Layer.mergeAll(
  RigLive,
  RigdDaemonAdminLive,
)

export const main = (argv: readonly string[]): Promise<number> =>
  Effect.runPromise(
    runRigdCli(argv).pipe(
      Effect.provide(RigdAdminLive),
    ),
  )

const logSignal = (signal: string) =>
  Effect.gen(function* () {
    const logger = yield* RigLogger
    yield* logger.error(
      new RigRuntimeError(
        `Received ${signal}. Shutting down.`,
        "Restart the interrupted rigd command when ready.",
        { signal },
      ),
    )
  }).pipe(Effect.provide(RigLoggerLive))

const handleSignal = (signal: string) => {
  void Effect.runPromise(logSignal(signal)).finally(() => process.exit(130))
}

process.on("SIGTERM", () => handleSignal("SIGTERM"))
process.on("SIGINT", () => handleSignal("SIGINT"))

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2))
  process.exitCode = exitCode
}

