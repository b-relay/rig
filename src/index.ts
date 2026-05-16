import { Effect, Layer } from "effect"

import { runRigCli } from "./rig/cli.js"
import { RigdDaemonAdmin, RigdDaemonAdminLive } from "./rig/daemon-admin.js"
import { RigDeployIntentsLive } from "./rig/deploy-intent.js"
import { RigDeploymentManagerLive, RigFileDeploymentStoreLive } from "./rig/deployments.js"
import { RigDoctorLive } from "./rig/doctor.js"
import { RigCliArgumentError, RigRuntimeError } from "./rig/errors.js"
import { RigFileHomeConfigStoreLive } from "./rig/home-config.js"
import { RigLifecycleLive } from "./rig/lifecycle.js"
import { rigRoot } from "./rig/paths.js"
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

const RuntimeLive = Layer.mergeAll(
  RigLive,
  RigDeploymentLive,
  RigDeployIntentsRuntimeLive,
  RigdRuntimeLive,
  RigdDaemonAdminLive,
  RigDoctorLive,
  Layer.provide(RigLifecycleLive, Layer.mergeAll(RigLive, RigdRuntimeLive)),
)

const isPassiveRigInvocation = (argv: readonly string[]): boolean =>
  argv.length === 0 ||
  argv[0] === "doctor" ||
  argv.includes("--help") ||
  argv.includes("-h") ||
  argv.includes("--version") ||
  argv.includes("--completions")

const requireInstalledRigd = (argv: readonly string[]) =>
  isPassiveRigInvocation(argv)
    ? Effect.void
    : Effect.gen(function* () {
      const admin = yield* RigdDaemonAdmin
      const status = yield* admin.status({ stateRoot: rigRoot() })
      if (status.installed && status.reachable) {
        return
      }

      return yield* Effect.fail(
        new RigCliArgumentError(
          "rigd is not installed or reachable.",
          "Run 'rigd install' to set up the daemon, or 'rigd status' to inspect it.",
          {
            installed: status.installed,
            running: status.running,
            reachable: status.reachable,
            stateRoot: status.stateRoot,
          },
        ),
      )
    })

const runRigClient = (argv: readonly string[]) =>
  Effect.gen(function* () {
    yield* requireInstalledRigd(argv)
    return yield* runRigCli(argv)
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const logger = yield* RigLogger
        if (error instanceof RigCliArgumentError) {
          yield* logger.error(error)
          return 1
        }
        return yield* Effect.fail(error)
      }),
    ),
  )

export const main = (argv: readonly string[]): Promise<number> =>
  Effect.runPromise(
    runRigClient(argv).pipe(
      Effect.provide(RuntimeLive),
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
