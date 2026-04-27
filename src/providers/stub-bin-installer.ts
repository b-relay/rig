import { join } from "node:path"
import { Effect, Layer } from "effect-v3"

import { rigBinPath } from "../core/rig-paths.js"
import { BinInstaller, type BinInstaller as BinInstallerService } from "../interfaces/bin-installer.js"
import type { BinService } from "../schema/config.js"
import { BinInstallerError } from "../schema/errors.js"

const binKey = (name: string, env: string): string => `${name}:${env}`

interface StubBinInstallerOptions {
  readonly buildFailures?: Readonly<Record<string, BinInstallerError>>
  readonly installFailures?: Readonly<Record<string, BinInstallerError>>
  readonly uninstallFailures?: Readonly<Record<string, BinInstallerError>>
}

export class StubBinInstaller implements BinInstallerService {
  readonly buildCalls: Array<{ readonly service: string; readonly workdir: string; readonly entrypoint: string }> = []
  readonly installCalls: Array<{ readonly name: string; readonly env: string; readonly binaryPath: string }> = []
  readonly uninstallCalls: Array<{ readonly name: string; readonly env: string }> = []
  private readonly installed = new Map<string, string>()

  constructor(private readonly options: StubBinInstallerOptions = {}) {}

  build(config: BinService, workdir: string): Effect.Effect<string, BinInstallerError> {
    this.buildCalls.push({ service: config.name, workdir, entrypoint: config.entrypoint })
    const failure = this.options.buildFailures?.[config.name]
    if (failure) {
      return Effect.fail(failure)
    }

    return Effect.succeed(join(workdir, config.entrypoint))
  }

  install(name: string, env: string, binaryPath: string): Effect.Effect<string, BinInstallerError> {
    this.installCalls.push({ name, env, binaryPath })
    const key = binKey(name, env)
    const failure = this.options.installFailures?.[key] ?? this.options.installFailures?.[name]
    if (failure) {
      return Effect.fail(failure)
    }

    const installedPath = rigBinPath(name, env)
    this.installed.set(key, installedPath)
    return Effect.succeed(installedPath)
  }

  uninstall(name: string, env: string): Effect.Effect<void, BinInstallerError> {
    this.uninstallCalls.push({ name, env })
    const key = binKey(name, env)
    const failure = this.options.uninstallFailures?.[key] ?? this.options.uninstallFailures?.[name]
    if (failure) {
      return Effect.fail(failure)
    }

    this.installed.delete(key)
    return Effect.void
  }

  installedPath(name: string, env: string): string | undefined {
    return this.installed.get(binKey(name, env))
  }
}

export const StubBinInstallerLive = Layer.succeed(BinInstaller, new StubBinInstaller())
