import { Effect, Layer } from "effect-v4"

import { runRig2Cli } from "./v2/cli.js"
import { V2DeployIntentsLive } from "./v2/deploy-intent.js"
import { V2DeploymentManagerLive, V2FileDeploymentStoreLive } from "./v2/deployments.js"
import { V2RuntimeError } from "./v2/errors.js"
import { V2LifecycleLive } from "./v2/lifecycle.js"
import { V2RigdLive } from "./v2/rigd.js"
import { Rig2Live, V2Logger, V2LoggerLive } from "./v2/services.js"

const V2DeploymentLive = Layer.provide(V2DeploymentManagerLive, V2FileDeploymentStoreLive)
const V2DeployIntentsRuntimeLive = Layer.provide(V2DeployIntentsLive, V2DeploymentLive)
const V2RigdRuntimeLive = Layer.provide(
  V2RigdLive,
  Layer.mergeAll(Rig2Live, V2DeploymentLive),
)

export const main = (argv: readonly string[]): Promise<number> =>
  Effect.runPromise(
    runRig2Cli(argv).pipe(
      Effect.provide(
        Layer.mergeAll(
          Rig2Live,
          V2DeploymentLive,
          V2DeployIntentsRuntimeLive,
          V2RigdRuntimeLive,
          Layer.provide(V2LifecycleLive, Rig2Live),
        ),
      ),
    ),
  )

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
