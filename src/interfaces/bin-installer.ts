import { Context, Effect } from "effect-v3"
import type { BinInstallerError } from "../schema/errors.js"
import type { BinService } from "../schema/config.js"

export interface BinInstaller {
  readonly build: (
    config: BinService,
    workdir: string
  ) => Effect.Effect<string, BinInstallerError>
  readonly install: (
    name: string,
    env: string,
    binaryPath: string
  ) => Effect.Effect<string, BinInstallerError>
  readonly uninstall: (
    name: string,
    env: string
  ) => Effect.Effect<void, BinInstallerError>
}

export const BinInstaller = Context.GenericTag<BinInstaller>("BinInstaller")
