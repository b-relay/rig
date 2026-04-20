export interface V2TaggedError {
  readonly _tag: string
  readonly message: string
  readonly hint: string
  readonly details?: Readonly<Record<string, unknown>>
}

export class V2CliArgumentError extends Error implements V2TaggedError {
  readonly _tag = "V2CliArgumentError"

  constructor(
    readonly message: string,
    readonly hint: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
  }
}

export class V2ConfigValidationError extends Error implements V2TaggedError {
  readonly _tag = "V2ConfigValidationError"

  constructor(
    readonly message: string,
    readonly hint: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
  }
}

export class V2RuntimeError extends Error implements V2TaggedError {
  readonly _tag = "V2RuntimeError"

  constructor(
    readonly message: string,
    readonly hint: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
  }
}

export type V2Error = V2CliArgumentError | V2ConfigValidationError | V2RuntimeError

export const isV2Error = (error: unknown): error is V2Error =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  "message" in error &&
  "hint" in error &&
  typeof error._tag === "string" &&
  typeof error.message === "string" &&
  typeof error.hint === "string"

export const unknownToV2CliError = (error: unknown): V2CliArgumentError => {
  if (isV2Error(error)) {
    return new V2CliArgumentError(error.message, error.hint, {
      originalTag: error._tag,
      ...(error.details ? { originalDetails: error.details } : {}),
    })
  }

  return new V2CliArgumentError(
    "Invalid rig2 command arguments.",
    "Run 'rig2 --help' or 'rig2 status --help' to inspect the v2 command surface.",
    {
      cause: error instanceof Error ? error.message : String(error),
    },
  )
}
