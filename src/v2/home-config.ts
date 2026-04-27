import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect-v4"

import { V2RuntimeError } from "./errors.js"
import type { V2ProviderProfileName } from "./provider-contracts.js"

const fieldDoc = <S extends Schema.Top>(schema: S, description: string): S["Rebuild"] =>
  schema.pipe(Schema.annotateKey({ description }))

const BranchName = Schema.String.check(
  Schema.isMinLength(1, { message: "Production branch must not be empty." }),
)

const PositiveInteger = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(1, { message: "Value must be at least one." }),
)

export const V2HomeConfigSchema = Schema.Struct({
  deploy: fieldDoc(
    Schema.optionalKey(Schema.Struct({
      productionBranch: fieldDoc(
        Schema.optionalKey(BranchName),
        "Default branch that git-push deploy intent maps to the live lane.",
      ),
      generated: fieldDoc(
        Schema.optionalKey(Schema.Struct({
          maxActive: fieldDoc(
            Schema.optionalKey(PositiveInteger),
            "Default maximum active generated deployments per project.",
          ),
          replacePolicy: fieldDoc(
            Schema.optionalKey(Schema.Union([Schema.Literal("oldest"), Schema.Literal("reject")])),
            "Default policy when generated deployment limits are reached.",
          ),
        })),
        "Machine default limits for generated deployment inventory.",
      ),
    })),
    "Machine/user defaults for deploy intent and generated deployments.",
  ),
  providers: fieldDoc(
    Schema.optionalKey(Schema.Struct({
      defaultProfile: fieldDoc(
        Schema.optionalKey(Schema.Union([
          Schema.Literal("default"),
          Schema.Literal("stub"),
          Schema.Literal("isolated-e2e"),
        ])),
        "Default provider profile used when a project does not select one.",
      ),
    })),
    "Machine/user provider defaults.",
  ),
  web: fieldDoc(
    Schema.optionalKey(Schema.Struct({
      controlPlane: fieldDoc(
        Schema.optionalKey(Schema.Union([
          Schema.Literal("localhost"),
          Schema.Literal("tailscale"),
          Schema.Literal("cloudflare"),
          Schema.Literal("disabled"),
        ])),
        "Preferred control-plane exposure mode for rig.b-relay.com integration.",
      ),
    })),
    "Machine/user web-control defaults.",
  ),
})

export type V2HomeConfigInput = Schema.Schema.Type<typeof V2HomeConfigSchema>

export interface V2HomeConfig {
  readonly deploy: {
    readonly productionBranch: string
    readonly generated: {
      readonly maxActive: number
      readonly replacePolicy: "oldest" | "reject"
    }
  }
  readonly providers: {
    readonly defaultProfile: V2ProviderProfileName
  }
  readonly web: {
    readonly controlPlane: "localhost" | "tailscale" | "cloudflare" | "disabled"
  }
}

export interface V2HomeConfigReadInput {
  readonly stateRoot: string
}

export interface V2HomeConfigWriteInput {
  readonly stateRoot: string
  readonly config: V2HomeConfigInput
}

export interface V2HomeConfigStoreService {
  readonly read: (input: V2HomeConfigReadInput) => Effect.Effect<V2HomeConfig, V2RuntimeError>
  readonly write: (input: V2HomeConfigWriteInput) => Effect.Effect<void, V2RuntimeError>
}

export const V2HomeConfigStore =
  Context.Service<V2HomeConfigStoreService>("rig/v2/V2HomeConfigStore")

export const v2HomeConfigDefaults: V2HomeConfig = {
  deploy: {
    productionBranch: "main",
    generated: {
      maxActive: 5,
      replacePolicy: "oldest",
    },
  },
  providers: {
    defaultProfile: "default",
  },
  web: {
    controlPlane: "localhost",
  },
}

export const v2HomeConfigPath = (stateRoot: string): string =>
  join(stateRoot, "config.json")

const normalizeV2HomeConfig = (config: V2HomeConfigInput): V2HomeConfig => ({
  deploy: {
    productionBranch: config.deploy?.productionBranch ?? v2HomeConfigDefaults.deploy.productionBranch,
    generated: {
      maxActive: config.deploy?.generated?.maxActive ?? v2HomeConfigDefaults.deploy.generated.maxActive,
      replacePolicy: config.deploy?.generated?.replacePolicy ?? v2HomeConfigDefaults.deploy.generated.replacePolicy,
    },
  },
  providers: {
    defaultProfile: config.providers?.defaultProfile ?? v2HomeConfigDefaults.providers.defaultProfile,
  },
  web: {
    controlPlane: config.web?.controlPlane ?? v2HomeConfigDefaults.web.controlPlane,
  },
})

const configError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new V2RuntimeError(message, hint, {
    cause: cause instanceof Error ? cause.message : String(cause),
    ...(details ?? {}),
  })

export const decodeV2HomeConfig = (input: unknown): Effect.Effect<V2HomeConfig, V2RuntimeError> =>
  Schema.decodeUnknownEffect(V2HomeConfigSchema)(input).pipe(
    Effect.map(normalizeV2HomeConfig),
    Effect.mapError((error) =>
      new V2RuntimeError(
        "Invalid v2 home config.",
        "Fix the home rig config so it matches the Effect Schema contract.",
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      ),
    ),
  )

export const V2FileHomeConfigStoreLive = Layer.succeed(V2HomeConfigStore, {
  read: (input) =>
    Effect.tryPromise({
      try: async () => {
        const path = v2HomeConfigPath(input.stateRoot)
        try {
          const raw = await readFile(path, "utf8")
          return JSON.parse(raw) as unknown
        } catch (cause) {
          if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
            return {}
          }
          throw cause
        }
      },
      catch: configError(
        "Unable to read v2 home config.",
        "Ensure the v2 state root is readable or repair the home config file.",
        { stateRoot: input.stateRoot },
      ),
    }).pipe(Effect.flatMap(decodeV2HomeConfig)),
  write: (input) =>
    decodeV2HomeConfig(input.config).pipe(
      Effect.flatMap((config) =>
        Effect.tryPromise({
          try: async () => {
            const path = v2HomeConfigPath(input.stateRoot)
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8")
          },
          catch: configError(
            "Unable to write v2 home config.",
            "Ensure the v2 state root is writable and retry.",
            { stateRoot: input.stateRoot },
          ),
        }),
      ),
    ),
} satisfies V2HomeConfigStoreService)
