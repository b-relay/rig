import { dirname, join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"

import {
  isPlatformNotFound,
  platformMakeDirectory,
  platformReadFileString,
  platformWriteFileString,
} from "./effect-platform.js"
import { RigRuntimeError } from "./errors.js"
import type { RigProviderProfileName } from "./provider-contracts.js"

const fieldDoc = <S extends Schema.Top>(schema: S, description: string): S["Rebuild"] =>
  schema.pipe(Schema.annotateKey({ description }))

const BranchName = Schema.String.check(
  Schema.isMinLength(1, { message: "Production branch must not be empty." }),
)

const PositiveInteger = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(1, { message: "Value must be at least one." }),
)

const NonEmptyString = Schema.String.check(
  Schema.isMinLength(1, { message: "Value must not be empty." }),
)

export const RigHomeConfigSchema = Schema.Struct({
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
      caddy: fieldDoc(
        Schema.optionalKey(Schema.Struct({
          caddyfile: fieldDoc(
            Schema.optionalKey(NonEmptyString),
            "Caddyfile path used by the bundled Caddy provider.",
          ),
          extraConfig: fieldDoc(
            Schema.optionalKey(Schema.Array(NonEmptyString)),
            "Additional Caddyfile lines inserted into each Rig-managed site block.",
          ),
          reload: fieldDoc(
            Schema.optionalKey(Schema.Struct({
              mode: fieldDoc(
                Schema.optionalKey(Schema.Union([
                  Schema.Literal("manual"),
                  Schema.Literal("command"),
                  Schema.Literal("disabled"),
                ])),
                "How Rig should handle reloading Caddy after config changes.",
              ),
              command: fieldDoc(
                Schema.optionalKey(NonEmptyString),
                "Command to show or run for reloading Caddy, depending on reload mode.",
              ),
            })),
            "Reload behavior for Caddy config changes.",
          ),
        })),
        "Machine/user defaults for the bundled Caddy provider.",
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
      hosted: fieldDoc(
        Schema.optionalKey(Schema.Struct({
          enabled: fieldDoc(
            Schema.optionalKey(Schema.Boolean),
            "Whether rigd should connect outbound to the hosted control plane.",
          ),
          endpoint: fieldDoc(
            Schema.optionalKey(NonEmptyString),
            "Hosted control-plane endpoint.",
          ),
          machineId: fieldDoc(
            Schema.optionalKey(NonEmptyString),
            "Stable machine identity used by the hosted control-plane transport.",
          ),
          pairingToken: fieldDoc(
            Schema.optionalKey(NonEmptyString),
            "Pairing token used when hosted transport crosses the public internet.",
          ),
        })),
        "Hosted control-plane identity and pairing settings.",
      ),
    })),
    "Machine/user web-control defaults.",
  ),
})

export type RigHomeConfigInput = Schema.Schema.Type<typeof RigHomeConfigSchema>

export interface RigHomeConfig {
  readonly deploy: {
    readonly productionBranch: string
    readonly generated: {
      readonly maxActive: number
      readonly replacePolicy: "oldest" | "reject"
    }
  }
  readonly providers: {
    readonly defaultProfile: RigProviderProfileName
    readonly caddy: {
      readonly caddyfile?: string
      readonly extraConfig: readonly string[]
      readonly reload: {
        readonly mode: "manual" | "command" | "disabled"
        readonly command?: string
      }
    }
  }
  readonly web: {
    readonly controlPlane: "localhost" | "tailscale" | "cloudflare" | "disabled"
    readonly hosted: {
      readonly enabled: boolean
      readonly endpoint?: string
      readonly machineId?: string
      readonly pairingToken?: string
    }
  }
}

export interface RigHomeConfigReadInput {
  readonly stateRoot: string
}

export interface RigHomeConfigWriteInput {
  readonly stateRoot: string
  readonly config: RigHomeConfigInput
}

export interface RigHomeConfigStoreService {
  readonly read: (input: RigHomeConfigReadInput) => Effect.Effect<RigHomeConfig, RigRuntimeError>
  readonly write: (input: RigHomeConfigWriteInput) => Effect.Effect<void, RigRuntimeError>
}

export const RigHomeConfigStore =
  Context.Service<RigHomeConfigStoreService>("rig/rig/RigHomeConfigStore")

export const rigHomeConfigDefaults: RigHomeConfig = {
  deploy: {
    productionBranch: "main",
    generated: {
      maxActive: 5,
      replacePolicy: "oldest",
    },
  },
  providers: {
    defaultProfile: "default",
    caddy: {
      extraConfig: [],
      reload: {
        mode: "manual",
      },
    },
  },
  web: {
    controlPlane: "localhost",
    hosted: {
      enabled: false,
    },
  },
}

export const rigHomeConfigPath = (stateRoot: string): string =>
  join(stateRoot, "config.json")

const normalizeRigHomeConfig = (config: RigHomeConfigInput): RigHomeConfig => ({
  deploy: {
    productionBranch: config.deploy?.productionBranch ?? rigHomeConfigDefaults.deploy.productionBranch,
    generated: {
      maxActive: config.deploy?.generated?.maxActive ?? rigHomeConfigDefaults.deploy.generated.maxActive,
      replacePolicy: config.deploy?.generated?.replacePolicy ?? rigHomeConfigDefaults.deploy.generated.replacePolicy,
    },
  },
  providers: {
    defaultProfile: config.providers?.defaultProfile ?? rigHomeConfigDefaults.providers.defaultProfile,
    caddy: {
      ...(config.providers?.caddy?.caddyfile ? { caddyfile: config.providers.caddy.caddyfile } : {}),
      extraConfig: config.providers?.caddy?.extraConfig ?? rigHomeConfigDefaults.providers.caddy.extraConfig,
      reload: {
        mode: config.providers?.caddy?.reload?.mode ?? rigHomeConfigDefaults.providers.caddy.reload.mode,
        ...(config.providers?.caddy?.reload?.command ? { command: config.providers.caddy.reload.command } : {}),
      },
    },
  },
  web: {
    controlPlane: config.web?.controlPlane ?? rigHomeConfigDefaults.web.controlPlane,
    hosted: {
      enabled: config.web?.hosted?.enabled ?? rigHomeConfigDefaults.web.hosted.enabled,
      ...(config.web?.hosted?.endpoint ? { endpoint: config.web.hosted.endpoint } : {}),
      ...(config.web?.hosted?.machineId ? { machineId: config.web.hosted.machineId } : {}),
      ...(config.web?.hosted?.pairingToken ? { pairingToken: config.web.hosted.pairingToken } : {}),
    },
  },
})

const configError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new RigRuntimeError(message, hint, {
    cause: cause instanceof Error ? cause.message : String(cause),
    ...(details ?? {}),
  })

export const decodeRigHomeConfig = (input: unknown): Effect.Effect<RigHomeConfig, RigRuntimeError> =>
  Schema.decodeUnknownEffect(RigHomeConfigSchema)(input).pipe(
    Effect.map(normalizeRigHomeConfig),
    Effect.mapError((error) =>
      new RigRuntimeError(
        "Invalid rig home config.",
        "Fix the home rig config so it matches the Effect Schema contract.",
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      ),
    ),
  )

export const RigFileHomeConfigStoreLive = Layer.succeed(RigHomeConfigStore, {
  read: (input) =>
    Effect.gen(function* () {
      const path = rigHomeConfigPath(input.stateRoot)
      return yield* platformReadFileString(path).pipe(
        Effect.matchEffect({
          onSuccess: (raw) => Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (cause) => cause,
          }),
          onFailure: (cause) => isPlatformNotFound(cause) ? Effect.succeed({}) : Effect.fail(cause),
        }),
      )
    }).pipe(
      Effect.mapError(configError(
        "Unable to read rig home config.",
        "Ensure the rig state root is readable or repair the home config file.",
        { stateRoot: input.stateRoot },
      )),
      Effect.flatMap(decodeRigHomeConfig),
    ),
  write: (input) =>
    decodeRigHomeConfig(input.config).pipe(
      Effect.flatMap((config) =>
        Effect.gen(function* () {
          const path = rigHomeConfigPath(input.stateRoot)
          yield* platformMakeDirectory(dirname(path))
          yield* platformWriteFileString(path, `${JSON.stringify(config, null, 2)}\n`)
        }).pipe(
          Effect.mapError(configError(
            "Unable to write rig home config.",
            "Ensure the rig state root is writable and retry.",
            { stateRoot: input.stateRoot },
          )),
        ),
      ),
    ),
} satisfies RigHomeConfigStoreService)
