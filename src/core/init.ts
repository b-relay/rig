import { join, resolve } from "node:path"
import { Effect } from "effect"

import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import { Registry } from "../interfaces/registry.js"
import type { InitArgs } from "../schema/args.js"
import { ConfigValidationError } from "../schema/errors.js"

const RIG_PACKAGE_SCRIPTS = {
  "rig:up": "rig2 up",
  "rig:down": "rig2 down",
  "rig:status": "rig2 status",
  "rig:logs": "rig2 logs",
} as const

const v2ProjectConfig = (
  name: string,
  providerProfile: InitArgs["providerProfile"],
) => ({
  name,
  description: `Rig v2 project for ${name}.`,
  components: {},
  local: {
    providerProfile,
  },
  live: {
    providerProfile,
  },
  deployments: {
    subdomain: "${branchSlug}",
    providerProfile,
  },
})

const invalidJsonError = (path: string, cause: unknown): ConfigValidationError =>
  new ConfigValidationError(
    path,
    [
      {
        path: [],
        code: "invalid_json",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    ],
    `Unable to parse ${path}.`,
    "Fix the JSON syntax and retry.",
  )

const rigJsonExistsError = (path: string): ConfigValidationError =>
  new ConfigValidationError(
    path,
    [
      {
        path: [],
        code: "already_exists",
        message: "rig.json already exists.",
      },
    ],
    "Cannot scaffold v2 config over an existing rig.json.",
    "Move or edit the existing rig.json before running `rig init --v2`.",
  )

const readJsonObject = (
  fileSystem: FileSystemService,
  path: string,
) =>
  fileSystem.read(path).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => invalidJsonError(path, cause),
      }),
    ),
    Effect.flatMap((value) => {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return Effect.succeed(value as Record<string, unknown>)
      }

      return Effect.fail(
        new ConfigValidationError(
          path,
          [
            {
              path: [],
              code: "invalid_type",
              message: "Expected a JSON object.",
            },
          ],
          `${path} must contain a JSON object.`,
          "Replace the file with an object-shaped package.json.",
        ),
      )
    }),
  )

const scaffoldV2Config = (
  fileSystem: FileSystemService,
  logger: LoggerService,
  name: string,
  repoPath: string,
  providerProfile: InitArgs["providerProfile"],
) =>
  Effect.gen(function* () {
    const rigJsonPath = join(repoPath, "rig.json")
    const exists = yield* fileSystem.exists(rigJsonPath)
    if (exists) {
      return yield* Effect.fail(rigJsonExistsError(rigJsonPath))
    }

    yield* fileSystem.write(
      rigJsonPath,
      `${JSON.stringify(v2ProjectConfig(name, providerProfile), null, 2)}\n`,
    )
    yield* logger.success(`Scaffolded v2 rig.json for ${name}`, {
      name,
      repoPath,
      providerProfile,
      path: rigJsonPath,
    })
  })

const addPackageScripts = (
  fileSystem: FileSystemService,
  logger: LoggerService,
  repoPath: string,
) =>
  Effect.gen(function* () {
    const packageJsonPath = join(repoPath, "package.json")
    const exists = yield* fileSystem.exists(packageJsonPath)
    if (!exists) {
      yield* logger.warn("Skipped package-manager integration; package.json was not found.", {
        repoPath,
      })
      return
    }

    const packageJson = yield* readJsonObject(fileSystem, packageJsonPath)
    const rawScripts = packageJson.scripts
    const scripts =
      typeof rawScripts === "object" && rawScripts !== null && !Array.isArray(rawScripts)
        ? { ...(rawScripts as Record<string, unknown>) }
        : {}

    const addedScripts: string[] = []
    for (const [name, command] of Object.entries(RIG_PACKAGE_SCRIPTS)) {
      if (!(name in scripts)) {
        scripts[name] = command
        addedScripts.push(name)
      }
    }

    yield* fileSystem.write(
      packageJsonPath,
      `${JSON.stringify(
        {
          ...packageJson,
          scripts,
        },
        null,
        2,
      )}\n`,
    )
    yield* logger.success("Updated package.json with rig scripts", {
      path: packageJsonPath,
      addedScripts,
    })
  })

export const runInitCommand = (args: InitArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const registry = yield* Registry
    const fileSystem = yield* FileSystem

    const repoPath = resolve(args.path)

    yield* registry.register(args.name, repoPath)

    if (args.v2) {
      yield* scaffoldV2Config(fileSystem, logger, args.name, repoPath, args.providerProfile)
    }

    if (args.packageScripts) {
      yield* addPackageScripts(fileSystem, logger, repoPath)
    }

    yield* logger.success(`Registered ${args.name} at ${repoPath}`, {
      name: args.name,
      repoPath,
    })

    return 0
  })
