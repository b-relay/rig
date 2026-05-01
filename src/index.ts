import { Effect, Layer } from "effect"

import { runRigCli } from "./rig/cli.js"
import { RigDeployIntentsLive } from "./rig/deploy-intent.js"
import { RigDeploymentManagerLive, RigFileDeploymentStoreLive } from "./rig/deployments.js"
import { RigDoctorLive } from "./rig/doctor.js"
import { RigRuntimeError } from "./rig/errors.js"
import { RigFileHomeConfigStoreLive } from "./rig/home-config.js"
import { RigLifecycleLive } from "./rig/lifecycle.js"
import { RigdLive } from "./rig/rigd.js"
import { RigLive, RigLogger, RigLoggerLive } from "./rig/services.js"

const RigDeploymentLive = Layer.provide(RigDeploymentManagerLive, RigFileDeploymentStoreLive)
const RigDeployIntentsRuntimeLive = Layer.provide(
  RigDeployIntentsLive,
  RigFileHomeConfigStoreLive,
)
const RigdRuntimeLive = Layer.provide(
  RigdLive,
  Layer.mergeAll(RigLive, RigDeploymentLive),
)

export const main = (argv: readonly string[]): Promise<number> =>
  Effect.runPromise(
    runRigCli(argv).pipe(
      Effect.provide(
        Layer.mergeAll(
          RigLive,
          RigDeploymentLive,
          RigDeployIntentsRuntimeLive,
          RigdRuntimeLive,
          RigDoctorLive,
          Layer.provide(RigLifecycleLive, Layer.mergeAll(RigLive, RigdRuntimeLive)),
        ),
      ),
    ),
  )

const logSignal = (signal: string) =>
  Effect.gen(function* () {
    const logger = yield* RigLogger
    yield* logger.error(
      new RigRuntimeError(
        `Received ${signal}. Shutting down.`,
        "Restart the interrupted rig command when ready.",
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
