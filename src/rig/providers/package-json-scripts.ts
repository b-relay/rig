import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import {
  platformChmod,
  platformCopyFile,
  platformMakeDirectory,
  platformReadFileBytes,
  platformWriteFileString,
} from "../effect-platform.js"
import { RigRuntimeError } from "../errors.js"
import { rigBinRoot } from "../paths.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
  RigRuntimeServiceConfig,
} from "../provider-contracts.js"

export interface RigPackageJsonScriptsCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type RigPackageJsonScriptsCommandRunner = (
  args: readonly string[],
  options?: { readonly cwd?: string },
) => Effect.Effect<RigPackageJsonScriptsCommandResult, RigRuntimeError>

export interface RigPackageJsonScriptsOptions {
  readonly binRoot?: string
}

export interface RigPackageJsonScriptsAdapter {
  readonly install: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly service: RigRuntimeServiceConfig
    },
    selected: RigProviderPluginForFamily<"package-manager">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const packageJsonScriptsProvider = {
  id: "package-json-scripts",
  family: "package-manager",
  source: "first-party",
  displayName: "package.json Scripts",
  capabilities: ["npm-compatible", "bun-compatible"],
} satisfies RigProviderPlugin

export const createPackageJsonScriptsAdapter = (
  options: RigPackageJsonScriptsOptions | undefined,
  runPlatformCommand: RigPackageJsonScriptsCommandRunner,
): RigPackageJsonScriptsAdapter => {
  const binRoot = options?.binRoot ?? rigBinRoot()

  const installName = (deployment: RigDeploymentRecord, serviceName: string): string => {
    if (deployment.kind === "live") return serviceName
    if (deployment.kind === "local") return `${serviceName}-dev`
    return `${serviceName}-${deployment.name}`
  }

  const installPath = (deployment: RigDeploymentRecord, serviceName: string): string =>
    join(binRoot, installName(deployment, serviceName))

  const isWithinWorkspace = (path: string, workspacePath: string): boolean => {
    const workspace = resolve(workspacePath)
    const candidate = resolve(path)
    const rel = relative(workspace, candidate)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  }

  const resolveEntrypoint = (entrypoint: string, workspacePath: string): string =>
    isAbsolute(entrypoint) ? entrypoint : resolve(workspacePath, entrypoint)

  const isBinaryContent = (content: Uint8Array): boolean => {
    const sample = content.subarray(0, 8192)
    return sample.includes(0)
  }

  const commandShim = (workspacePath: string, command: string): string =>
    `#!/bin/sh\ncd ${JSON.stringify(workspacePath)} && exec ${command} "$@"\n`

  const scriptShim = (workspacePath: string, entrypoint: string): string =>
    `#!/bin/sh\ncd ${JSON.stringify(workspacePath)} && exec ./${entrypoint} "$@"\n`

  const installEntrypoint = (
    deployment: RigDeploymentRecord,
    service: Extract<RigRuntimeServiceConfig, { readonly type: "bin" }>,
    selected: RigProviderPluginForFamily<"package-manager">,
  ): Effect.Effect<string, RigRuntimeError> => Effect.gen(function* () {
    const destination = installPath(deployment, service.name)
    yield* platformMakeDirectory(dirname(destination))

    if (service.entrypoint.includes(" ") && !service.build) {
      yield* platformWriteFileString(destination, commandShim(deployment.workspacePath, service.entrypoint))
      yield* platformChmod(destination, 0o755)
      return destination
    }

    if (service.entrypoint.includes(" ") && service.build) {
      return yield* Effect.fail(new RigRuntimeError(
        `Installed component '${service.name}' cannot use a command entrypoint with a build command.`,
        "Use a file entrypoint for built CLI artifacts.",
        {
          providerId: selected.id,
          component: service.name,
          deployment: deployment.name,
          entrypoint: service.entrypoint,
          build: service.build,
        },
      ))
    }

    const entrypoint = resolveEntrypoint(service.entrypoint, deployment.workspacePath)
    if (!isWithinWorkspace(entrypoint, deployment.workspacePath)) {
      return yield* Effect.fail(new RigRuntimeError(
        `Installed component '${service.name}' resolves outside the deployment workspace.`,
        "Use an entrypoint path inside the deployment workspace.",
        {
          providerId: selected.id,
          component: service.name,
          deployment: deployment.name,
          entrypoint: service.entrypoint,
          workspacePath: deployment.workspacePath,
        },
      ))
    }

    const content = yield* platformReadFileBytes(entrypoint)
    if (isBinaryContent(content)) {
      yield* platformCopyFile(entrypoint, destination)
    } else if (service.build) {
      yield* platformCopyFile(entrypoint, destination)
    } else {
      yield* platformWriteFileString(destination, scriptShim(deployment.workspacePath, service.entrypoint))
    }
    yield* platformChmod(destination, 0o755)
    return destination
  })

  const install = (input: {
    readonly deployment: RigDeploymentRecord
    readonly service: RigRuntimeServiceConfig
  }, selected: RigProviderPluginForFamily<"package-manager">): Effect.Effect<string, RigRuntimeError> => {
    if (input.service.type !== "bin") {
      return Effect.succeed(`${selected.family}:${selected.id}:install:${input.service.name}`)
    }

    return Effect.gen(function* () {
      if ("build" in input.service && input.service.build) {
        const { exitCode, stdout, stderr } = yield* runPlatformCommand(
          ["sh", "-lc", input.service.build],
          { cwd: input.deployment.workspacePath },
        )

        if (exitCode !== 0) {
          return yield* Effect.fail(new RigRuntimeError(
            `Package build failed for '${input.service.name}' with exit code ${exitCode}.`,
            "Fix the installed component build command before retrying the deploy action.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              build: input.service.build,
              exitCode,
              stdout,
              stderr,
            },
          ))
        }
      }

      const destination = yield* installEntrypoint(input.deployment, input.service, selected)
      return `${selected.family}:${selected.id}:install:${input.service.name}:installed:${destination}`
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof RigRuntimeError
          ? cause
          : new RigRuntimeError(
            `Unable to install package component '${input.service.name}'.`,
            "Ensure the deployment workspace, entrypoint, build command, and rig bin root are available.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              ...("build" in input.service && input.service.build ? { build: input.service.build } : {}),
              entrypoint: input.service.entrypoint,
              binRoot,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          ),
      ),
    )
  }

  return { install }
}
