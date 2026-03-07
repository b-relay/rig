import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"

import { BinInstaller } from "../interfaces/bin-installer.js"
import { Logger } from "../interfaces/logger.js"
import { Registry } from "../interfaces/registry.js"
import type { BinService, RigConfig } from "../schema/config.js"
import { ConfigValidationError } from "../schema/errors.js"
import { loadRigConfig } from "./config.js"
import { configError } from "./shared.js"

const resolveSetupService = (
  configPath: string,
  config: RigConfig,
): Effect.Effect<BinService, ConfigValidationError> => {
  const prod = config.environments.prod
  if (!prod) {
    return Effect.fail(
      configError(
        configPath,
        "Setup requires a prod environment in rig.json.",
        "Define environments.prod.services with a bin service for rig.",
        { code: "setup", path: ["environments", "prod"] },
      ),
    )
  }

  const service = prod.services.find(
    (candidate): candidate is BinService => candidate.type === "bin" && candidate.name === config.name,
  )

  if (!service) {
    return Effect.fail(
      configError(
        configPath,
        `Setup requires a prod bin service named '${config.name}'.`,
        `Define environments.prod.services[] with { name: "${config.name}", type: "bin", ... }.`,
        { code: "setup", path: ["environments", "prod", "services"] },
      ),
    )
  }

  return Effect.succeed(service)
}

const rigBinDir = (): string => join(homedir(), ".rig", "bin")

const pathContainsRigBin = (pathValue: string | undefined): boolean => {
  const binDir = rigBinDir()
  const entries = (pathValue ?? "").split(":").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  return entries.includes(binDir)
}

export const runSetupCommand = () =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const binInstaller = yield* BinInstaller
    const registry = yield* Registry

    const repoPath = resolve(process.cwd())
    const configPath = join(repoPath, "rig.json")
    const config = yield* loadRigConfig(repoPath)
    const service = yield* resolveSetupService(configPath, config)

    const builtBinary = yield* binInstaller.build(service, repoPath)
    const installedPath = yield* binInstaller.install(service.name, "prod", builtBinary)

    yield* registry.register(config.name, repoPath)

    const pathConfigured = pathContainsRigBin(process.env.PATH)
    if (!pathConfigured) {
      yield* logger.warn("~/.rig/bin is not on PATH.", {
        binDir: rigBinDir(),
      })
      yield* logger.info("Add rig binaries to PATH and restart your shell.", {
        exportCommand: 'export PATH="$HOME/.rig/bin:$PATH"',
      })
    }

    yield* logger.success("Rig setup complete.", {
      name: config.name,
      repoPath,
      builtBinary,
      installedPath,
      pathConfigured,
    })

    return 0
  })
