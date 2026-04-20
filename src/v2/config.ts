import { Effect, Schema } from "effect-v4"

import { V2ConfigValidationError } from "./errors.js"

const fieldDoc = <S extends Schema.Top>(schema: S, description: string): S["Rebuild"] =>
  schema.pipe(Schema.annotateKey({ description }))

const schemaDoc = <S extends Schema.Top>(schema: S, description: string): S["Rebuild"] =>
  schema.pipe(Schema.annotate({ description }))

const NonEmptyString = (description: string) =>
  fieldDoc(
    Schema.String.check(Schema.isMinLength(1, { message: "Must not be empty." })),
    description,
  )

const ProjectName = schemaDoc(
  Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
      message: "Use letters, numbers, underscores, or hyphens, and start with a letter or number.",
    }),
  ),
  "Stable registered project name used for v2 project identity.",
)

const HealthCheck = schemaDoc(
  Schema.String.check(
    Schema.isMinLength(1, { message: "Health check must not be empty." }),
    Schema.makeFilter<string>(
      (value) =>
        value.includes("0.0.0.0")
          ? "Health checks must target 127.0.0.1 or localhost, never 0.0.0.0."
          : true,
      { identifier: "localhostOnlyHealthCheck" },
    ),
  ),
  "HTTP URL or command health check for a managed component. Network checks must not bind to 0.0.0.0.",
)

const Port = schemaDoc(
  Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(1, { message: "Port must be greater than zero." }),
    Schema.isLessThanOrEqualTo(65535, { message: "Port must be at most 65535." }),
  ),
  "Concrete TCP port reserved by rigd for a managed component.",
)

export const V2ManagedComponentSchema = Schema.Struct({
  mode: fieldDoc(Schema.Literal("managed"), "Marks this component as a supervised long-running runtime."),
  command: NonEmptyString("Command used to start the managed component."),
  port: fieldDoc(Schema.optionalKey(Port), "Optional concrete port required by this component."),
  health: fieldDoc(Schema.optionalKey(HealthCheck), "Optional health check used for readiness and status."),
})

export const V2InstalledComponentSchema = Schema.Struct({
  mode: fieldDoc(Schema.Literal("installed"), "Marks this component as an installed executable surface."),
  entrypoint: NonEmptyString("Executable entrypoint or source file used for installation."),
  build: fieldDoc(Schema.optionalKey(Schema.String), "Optional build command for producing the installed artifact."),
})

export const V2ComponentSchema = Schema.Union([
  V2ManagedComponentSchema,
  V2InstalledComponentSchema,
])

const LaneOverrideSchema = Schema.Struct({
  command: fieldDoc(Schema.optionalKey(Schema.String), "Optional lane-specific command override."),
  health: fieldDoc(Schema.optionalKey(HealthCheck), "Optional lane-specific health check override."),
  port: fieldDoc(Schema.optionalKey(Port), "Optional lane-specific port override."),
})

export const V2ProjectConfigSchema = Schema.Struct({
  name: fieldDoc(ProjectName, "Stable registered project name."),
  components: fieldDoc(
    Schema.Record(Schema.String, V2ComponentSchema),
    "Shared component definitions keyed by component name.",
  ),
  local: fieldDoc(Schema.optionalKey(LaneOverrideSchema), "Optional working-copy lane overrides."),
  live: fieldDoc(Schema.optionalKey(LaneOverrideSchema), "Optional stable built lane overrides."),
  deployments: fieldDoc(Schema.optionalKey(LaneOverrideSchema), "Optional generated deployment template overrides."),
})

export type V2ProjectConfig = Schema.Schema.Type<typeof V2ProjectConfigSchema>

export const V2StatusInputSchema = Schema.Struct({
  project: fieldDoc(ProjectName, "Project selected with --project for a repo-external rig2 status command."),
  stateRoot: NonEmptyString("Isolated v2 state root. Defaults to ~/.rig-v2 and never reuses ~/.rig."),
})

export type V2StatusInput = Schema.Schema.Type<typeof V2StatusInputSchema>

const validationError = (scope: string, error: unknown): V2ConfigValidationError =>
  new V2ConfigValidationError(
    `Invalid ${scope}.`,
    "Fix the v2 input so it matches the Effect Schema contract.",
    { cause: error instanceof Error ? error.message : String(error) },
  )

export const decodeV2ProjectConfig = (input: unknown) =>
  Schema.decodeUnknownEffect(V2ProjectConfigSchema)(input).pipe(
    Effect.mapError((error) => validationError("v2 project config", error)),
  )

export const decodeV2StatusInput = (input: unknown) =>
  Schema.decodeUnknownEffect(V2StatusInputSchema)(input).pipe(
    Effect.mapError((error) => validationError("rig2 status input", error)),
  )
