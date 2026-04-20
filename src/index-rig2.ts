import { Effect } from "effect-v4"

import { runRig2Cli } from "./v2/cli.js"
import { V2RuntimeError } from "./v2/errors.js"
import { Rig2Live, V2Logger, V2LoggerLive } from "./v2/services.js"

export const main = (argv: readonly string[]): Promise<number> =>
  Effect.runPromise(runRig2Cli(argv).pipe(Effect.provide(Rig2Live)))

const logSignal = (signal: string) =>
  Effect.gen(function* () {
    const logger = yield* V2Logger
    yield* logger.error(
      new V2RuntimeError(
        `Received ${signal}. Shutting down.`,
        "Restart the interrupted rig2 command when ready.",
        { signal },
      ),
    )
  }).pipe(Effect.provide(V2LoggerLive))

const handleSignal = (signal: string) => {
  void Effect.runPromise(logSignal(signal)).finally(() => process.exit(130))
}

process.on("SIGTERM", () => handleSignal("SIGTERM"))
process.on("SIGINT", () => handleSignal("SIGINT"))

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2))
  process.exitCode = exitCode
}
