import { ConfigError } from "../config/errors";

/** Expected failures carry a stable code, safe user guidance, and bounded context. */
export class RigError extends Error {
  readonly _tag = "RigError";
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "RigError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asRigError(error: unknown): RigError {
  if (error instanceof RigError) return error;
  if (error instanceof ConfigError)
    return new RigError(
      error.code.toUpperCase(),
      error.message,
      error.hint,
      error.context,
    );
  return new RigError(
    "UNEXPECTED",
    "Rig could not complete this operation.",
    "Inspect the diagnostic log for details.",
    { cause: errorMessage(error) },
  );
}
