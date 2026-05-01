export interface RigTaggedError {
  readonly _tag: string
  readonly message: string
  readonly hint: string
  readonly details?: Readonly<Record<string, unknown>>
}

export class RigCliArgumentError extends Error implements RigTaggedError {
  readonly _tag = "RigCliArgumentError"

  constructor(
    readonly message: string,
    readonly hint: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
  }
}

export class RigConfigValidationError extends Error implements RigTaggedError {
  readonly _tag = "RigConfigValidationError"

  constructor(
    readonly message: string,
    readonly hint: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
  }
}

export class RigRuntimeError extends Error implements RigTaggedError {
  readonly _tag = "RigRuntimeError"

  constructor(
    readonly message: string,
    readonly hint: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
  }
}

export type RigError = RigCliArgumentError | RigConfigValidationError | RigRuntimeError

export const isRigError = (error: unknown): error is RigError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  "message" in error &&
  "hint" in error &&
  typeof error._tag === "string" &&
  typeof error.message === "string" &&
  typeof error.hint === "string"

export const unknownToRigCliError = (error: unknown): RigCliArgumentError => {
  if (isRigError(error)) {
    return new RigCliArgumentError(error.message, error.hint, {
      originalTag: error._tag,
      ...(error.details ? { originalDetails: error.details } : {}),
    })
  }

  return new RigCliArgumentError(
    "Invalid rig command arguments.",
    "Run 'rig --help' or 'rig status --help' to inspect the rig command surface.",
    {
      cause: error instanceof Error ? error.message : String(error),
    },
  )
}
