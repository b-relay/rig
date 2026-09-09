import { ConfigError } from "../config/errors";

/** Expected failures carry a stable code, safe user guidance, and bounded context. */
export class RigError extends Error {
  readonly _tag = "RigError";
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    readonly causes: FailureCauses = {},
  ) {
    super(message);
    this.name = "RigError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asRigError(error: unknown): RigError {
  try {
    if (error instanceof RigError) return error;
    if (error instanceof ConfigError)
      return new RigError(
        error.code.toUpperCase(),
        error.message,
        error.hint,
        error.context,
      );
  } catch {
    /* Untrusted thrown values may reject even prototype inspection. */
  }
  return new RigError(
    "UNEXPECTED",
    "Rig could not complete this operation.",
    "Inspect the diagnostic log for details.",
    {},
    failureCauses(error),
  );
}

/** Closed vocabulary: error text, arbitrary codes and nested details never cross this boundary. */
export const failureCategories = [
  "health",
  "process",
  "effects",
  "storage",
  "config",
  "rig",
  "unexpected",
  "non-error",
] as const;
export type FailureCategory = (typeof failureCategories)[number];
/** Normalize the existing public failure while retaining only classified evidence. */
export function retainFailureCauses(
  outcome: unknown,
  primary: unknown,
  recovery: unknown,
): RigError {
  const failure = asRigError(outcome);
  return new RigError(
    failure.code,
    failure.message,
    failure.hint,
    failure.details,
    failureCauses(primary, recovery),
  );
}
export interface FailureCauses {
  primaryCause?: FailureCategory;
  recoveryCause?: FailureCategory;
}
export function failureCategory(error: unknown): FailureCategory {
  try {
    if (error instanceof ConfigError) return "config";
    if (error instanceof RigError) {
      switch (error.code) {
        case "HEALTH_FAILED":
          return "health";
        case "STOP_INCOMPLETE":
        case "PROCESS_UNKNOWN":
        case "START_ROLLBACK_FAILED":
          return "process";
        case "EFFECTS_SCOPE":
        case "EFFECTS_RECOVERY":
        case "EFFECTS_CHECKPOINT":
        case "EFFECTS_COMMITTED":
        case "EFFECTS_CHANGED":
        case "EFFECTS_PREPARATION_PRESERVED":
        case "ARTIFACT_CONFLICT":
          return "effects";
        case "STATE_READ":
        case "STATE_CORRUPT":
          return "storage";
        default:
          return "rig";
      }
    }
    if (error instanceof Error) return "unexpected";
  } catch {
    /* Malformed providers cannot disrupt failure reporting. */
  }
  return "non-error";
}
export function failureCauses(
  primary: unknown,
  recovery?: unknown,
): FailureCauses {
  return {
    primaryCause: failureCategory(primary),
    ...(arguments.length > 1
      ? { recoveryCause: failureCategory(recovery) }
      : {}),
  };
}
export function diagnosticCauses(error: unknown): FailureCauses {
  try {
    if (error instanceof RigError) {
      const primaryCause = error.causes.primaryCause;
      const recoveryCause = error.causes.recoveryCause;
      if (failureCategories.some((value) => value === primaryCause))
        return {
          primaryCause,
          ...(failureCategories.some((value) => value === recoveryCause)
            ? { recoveryCause }
            : {}),
        };
    }
  } catch {
    /* Classification remains total for malformed provider values. */
  }
  return failureCauses(error);
}

/** Inspect an untrusted failure without allowing its prototype or code getter to replace it. */
export function diagnosticErrorCode(error: unknown): string {
  try {
    if (error instanceof RigError) {
      const code = error.code;
      if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code))
        return code;
    }
  } catch {
    /* Diagnostic preparation is best effort, including property inspection. */
  }
  return "UNEXPECTED";
}
