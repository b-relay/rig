import { Effect, Layer } from "effect"

import { runRigCli } from "./v2/cli.js"
import { V2DeployIntentsLive } from "./v2/deploy-intent.js"
import { V2DeploymentManagerLive, V2FileDeploymentStoreLive } from "./v2/deployments.js"
import { V2DoctorLive } from "./v2/doctor.js"
import { V2RuntimeError } from "./v2/errors.js"
import { V2FileHomeConfigStoreLive } from "./v2/home-config.js"
import { V2LifecycleLive } from "./v2/lifecycle.js"
import { V2RigdLive } from "./v2/rigd.js"
import { RigLive, V2Logger, V2LoggerLive } from "./v2/services.js"

const V2DeploymentLive = Layer.provide(V2DeploymentManagerLive, V2FileDeploymentStoreLive)
const V2DeployIntentsRuntimeLive = Layer.provide(
  V2DeployIntentsLive,
  V2FileHomeConfigStoreLive,
)
const V2RigdRuntimeLive = Layer.provide(
  V2RigdLive,
  Layer.mergeAll(RigLive, V2DeploymentLive),
)

export const main = (argv: readonly string[]): Promise<number> =>
  Effect.runPromise(
    runRigCli(argv).pipe(
      Effect.provide(
        Layer.mergeAll(
          RigLive,
          V2DeploymentLive,
          V2DeployIntentsRuntimeLive,
          V2RigdRuntimeLive,
          V2DoctorLive,
          Layer.provide(V2LifecycleLive, Layer.mergeAll(RigLive, V2RigdRuntimeLive)),
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
        "Restart the interrupted rig command when ready.",
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
