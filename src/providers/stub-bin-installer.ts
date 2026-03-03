import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"

import { BinInstaller, type BinInstaller as BinInstallerService } from "../interfaces/bin-installer.js"
import type { BinService } from "../schema/config.js"
import type { BinInstallerError } from "../schema/errors.js"

const binName = (name: string, env: string): string => (env === "dev" ? `${name}-dev` : name)

export class StubBinInstaller implements BinInstallerService {
  build(config: BinService, workdir: string): Effect.Effect<string, BinInstallerError> {
    return Effect.succeed(join(workdir, config.entrypoint))
  }

  install(name: string, env: string, _binaryPath: string): Effect.Effect<string, BinInstallerError> {
    return Effect.succeed(join(homedir(), ".rig", "bin", binName(name, env)))
  }

  uninstall(_name: string, _env: string): Effect.Effect<void, BinInstallerError> {
    return Effect.void
  }
}

export const StubBinInstallerLive = Layer.succeed(BinInstaller, new StubBinInstaller())
