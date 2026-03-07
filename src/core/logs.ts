import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import { ServiceRunner } from "../interfaces/service-runner.js"
import type { LogsArgs } from "../schema/args.js"
import { CliArgumentError } from "../schema/errors.js"
import { loadProjectConfig, resolveEnvironment } from "./config.js"

const missingServiceError = (
  name: string,
  env: "dev" | "prod",
  service: string,
  available: readonly string[],
) =>
  new CliArgumentError(
    "logs",
    `Service '${service}' is not defined for project '${name}' (${env}).`,
    "Choose a service listed in rig.json or omit --service to stream all services.",
    { name, env, service, availableServices: available },
  )

export const runLogsCommand = (args: LogsArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const serviceRunner = yield* ServiceRunner

    const loaded = yield* loadProjectConfig(args.name)
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)
    const availableServices = environment.services.map((service) => service.name)

    if (args.service && !availableServices.includes(args.service)) {
      return yield* Effect.fail(
        missingServiceError(args.name, args.env, args.service, availableServices),
      )
    }

    const targets = args.service ? [args.service] : availableServices

    for (const serviceName of targets) {
      const output = yield* serviceRunner.logs(serviceName, {
        lines: args.lines,
        follow: args.follow,
        service: args.service,
      })

      yield* logger.info(output.length > 0 ? output : `(no logs for ${serviceName})`)
    }

    return 0
  })
