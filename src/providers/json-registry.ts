import { dirname } from "node:path"
import { Effect, Layer } from "effect"

import { rigRegistryPath } from "../core/rig-paths.js"
import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Registry, type Registry as RegistryService, type RegistryEntry } from "../interfaces/registry.js"
import { RegistryError } from "../schema/errors.js"

type RawRegistryValue =
  | string
  | {
      readonly repoPath: string
      readonly registeredAt?: string
    }

type RawRegistry = Record<string, RawRegistryValue>

const DEFAULT_REGISTRY_PATH = rigRegistryPath()
const PROJECT_NAME_RE = /^[a-z0-9-]+$/

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const normalizeEntry = (name: string, value: RawRegistryValue): RegistryEntry => {
  if (typeof value === "string") {
    return {
      name,
      repoPath: value,
      registeredAt: new Date(0),
    }
  }

  return {
    name,
    repoPath: value.repoPath,
    registeredAt: value.registeredAt ? new Date(value.registeredAt) : new Date(),
  }
}

const toRawEntry = (entry: RegistryEntry): { readonly repoPath: string; readonly registeredAt: string } => ({
  repoPath: entry.repoPath,
  registeredAt: entry.registeredAt.toISOString(),
})

export class JSONRegistry implements RegistryService {
  constructor(
    private readonly fileSystem: FileSystemService,
    private readonly registryPath = DEFAULT_REGISTRY_PATH,
  ) {}

  register(name: string, repoPath: string): Effect.Effect<void, RegistryError> {
    if (!PROJECT_NAME_RE.test(name)) {
      return Effect.fail(
        new RegistryError(
          "register",
          name,
          "Project name must be lowercase alphanumeric with hyphens only.",
          "Use names like `my-project`.",
        ),
      )
    }

    if (!isNonEmptyString(repoPath)) {
      return Effect.fail(
        new RegistryError(
          "register",
          name,
          "Repository path must be a non-empty string.",
          "Provide a valid repository path.",
        ),
      )
    }

    return this.readRegistry().pipe(
      Effect.flatMap((registry) => {
        const next: RawRegistry = {
          ...registry,
          [name]: {
            repoPath,
            registeredAt: new Date().toISOString(),
          },
        }

        return this.writeRegistry(next, "register", name)
      }),
      Effect.mapError((cause) =>
        cause instanceof RegistryError
          ? cause
          : new RegistryError("register", name, causeMessage(cause), "Check registry file permissions."),
      ),
    )
  }

  unregister(name: string): Effect.Effect<void, RegistryError> {
    return this.readRegistry().pipe(
      Effect.flatMap((registry) => {
        const next: RawRegistry = { ...registry }
        delete next[name]
        return this.writeRegistry(next, "unregister", name)
      }),
      Effect.mapError((cause) =>
        cause instanceof RegistryError
          ? cause
          : new RegistryError("unregister", name, causeMessage(cause), "Check registry file permissions."),
      ),
    )
  }

  resolve(name: string): Effect.Effect<string, RegistryError> {
    return this.readRegistry().pipe(
      Effect.flatMap((registry) => {
        const raw = registry[name]
        if (!raw) {
          return Effect.fail(
            new RegistryError(
              "resolve",
              name,
              `Project '${name}' is not registered.`,
              "Run `rig init <name> --path <repo-path>` first.",
            ),
          )
        }

        return Effect.succeed(normalizeEntry(name, raw).repoPath)
      }),
      Effect.mapError((cause) =>
        cause instanceof RegistryError
          ? cause
          : new RegistryError("resolve", name, causeMessage(cause), "Check registry file permissions."),
      ),
    )
  }

  list(): Effect.Effect<readonly RegistryEntry[], RegistryError> {
    return this.readRegistry().pipe(
      Effect.map((registry) =>
        Object.entries(registry)
          .map(([name, value]) => normalizeEntry(name, value))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
      Effect.mapError((cause) =>
        cause instanceof RegistryError
          ? cause
          : new RegistryError("list", "*", causeMessage(cause), "Check registry file permissions."),
      ),
    )
  }

  private readRegistry(): Effect.Effect<RawRegistry, RegistryError> {
    const registryPath = this.registryPath

    return this.ensureRegistryFile().pipe(
      Effect.flatMap(() => this.fileSystem.read(registryPath)),
      Effect.flatMap((raw) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (cause) =>
              new RegistryError(
                "list",
                "*",
                causeMessage(cause),
                `Fix invalid JSON in ${registryPath}.`,
              ),
          })

          if (!isObject(parsed)) {
            return yield* Effect.fail(
              new RegistryError(
                "list",
                "*",
                "Registry must be a JSON object.",
                `Fix invalid JSON in ${registryPath}.`,
              ),
            )
          }

          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string") {
              if (!isNonEmptyString(value)) {
                return yield* Effect.fail(
                  new RegistryError(
                    "list",
                    "*",
                    `Registry entry '${key}' must have a non-empty repoPath.`,
                    `Fix invalid JSON in ${registryPath}.`,
                  ),
                )
              }
              continue
            }

            if (!isObject(value) || !isNonEmptyString(value.repoPath)) {
              return yield* Effect.fail(
                new RegistryError(
                  "list",
                  "*",
                  `Registry entry '${key}' must be a string or { repoPath, registeredAt } object with non-empty repoPath.`,
                  `Fix invalid JSON in ${registryPath}.`,
                ),
              )
            }
          }

          return parsed as RawRegistry
        }),
      ),
      Effect.mapError((cause) =>
        cause instanceof RegistryError
          ? cause
          : new RegistryError("list", "*", causeMessage(cause), `Unable to read ${registryPath}.`),
      ),
    )
  }

  private writeRegistry(
    registry: RawRegistry,
    operation: RegistryError["operation"],
    name: string,
  ): Effect.Effect<void, RegistryError> {
    const canonical: Record<string, ReturnType<typeof toRawEntry>> = {}

    for (const [entryName, value] of Object.entries(registry)) {
      canonical[entryName] = toRawEntry(normalizeEntry(entryName, value))
    }

    return this.fileSystem.write(this.registryPath, `${JSON.stringify(canonical, null, 2)}\n`).pipe(
      Effect.mapError((cause) =>
        new RegistryError(operation, name, causeMessage(cause), `Unable to write ${this.registryPath}.`),
      ),
    )
  }

  private ensureRegistryFile(): Effect.Effect<void, RegistryError> {
    return this.fileSystem.exists(this.registryPath).pipe(
      Effect.flatMap((exists) => {
        if (exists) {
          return Effect.void
        }

        return this.fileSystem.mkdir(dirname(this.registryPath)).pipe(
          Effect.flatMap(() => this.fileSystem.write(this.registryPath, "{}\n")),
        )
      }),
      Effect.mapError((cause) =>
        new RegistryError(
          "list",
          "*",
          causeMessage(cause),
          `Ensure ${dirname(this.registryPath)} is writable.`,
        ),
      ),
    )
  }
}

export const JSONRegistryLive = Layer.effect(
  Registry,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    return new JSONRegistry(fileSystem)
  }),
)
