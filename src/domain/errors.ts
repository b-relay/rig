import { ConfigError } from "../config/errors";
import { z } from "zod";

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

/** Failures whose message and hint already tell the user what to change: their own arguments,
 * config, repository, host setup, or application. Everything else is an internal fault whose
 * Operation id and diagnostic path are part of the report. */
const userCorrectableCodes: ReadonlySet<string> = new Set([
  "USAGE",
  "CANCELLED",
  "STATE_UNCONVERTED",
  "CONVERSION_NEEDS_DEPLOY",
  "PRODUCTION_CONFIRMATION",
  "TARGET_REQUIRED",
  "TARGET_MISSING",
  "TARGETS_RUNNING",
  "PROJECT_REQUIRED",
  "PROJECT_MISSING",
  "PROJECT_NAME",
  "PROJECT_IDENTITY",
  "PROJECT_CONFLICT",
  "PROJECT_PATH_CONFLICT",
  "PROJECT_MOVED",
  "PROJECT_PATH",
  "PROJECT_ACTIVE",
  "PATH_REQUIRED",
  "PREVIEW_REQUIRED",
  "PREVIEW_NAME",
  "PREVIEW_LIMIT",
  "DEPLOY_TARGET",
  "DESTROY_TARGET",
  "BRANCH_POLICY",
  "GIT_REQUIRED",
  "GIT_BARE",
  "GIT_PATH_MISSING",
  "GIT_PATH_UNREADABLE",
  "GIT_LOCAL_BRANCH",
  "GIT_BRANCH",
  "GIT_DETACHED",
  "GIT_COMMIT",
  "GIT_REF",
  "GIT_REMOTE_CONFLICT",
  "GIT_REMOTE_MISSING",
  "GIT_UPSTREAM",
  "INVALID_CONFIG",
  "INVALID_YAML",
  "INVALID_EDIT",
  "MISSING_CONFIG",
  "MISSING_DIRECTORY",
  "ENV_FILE",
  "ENV_FILE_MISSING",
  "PORT_RESERVED",
  "PORT_UNAVAILABLE",
  "HEALTH_FAILED",
  "BUILD_FAILED",
  "BUILD_TIMEOUT",
  "BUILD_UNKNOWN",
  "PREPARATION_INCOMPLETE",
  "DEPENDENCIES_FAILED",
  "DEPENDENCIES_TIMEOUT",
  "LOG_LIMIT",
  "DAEMON_MISSING",
  "DAEMON_TOKEN",
  "DAEMON_UNREACHABLE",
  "DAEMON_TIMEOUT",
  "DAEMON_PROTOCOL",
  "DAEMON_RUNNING",
  "DAEMON_DRAINING",
  "UNAUTHORIZED",
  "CADDY_UNAVAILABLE",
  "PROVIDER_MISSING",
]);
/** The user ended the command before it changed anything; the hint says what, if anything, still runs. */
export function cancelled(hint = "No runtime change was requested."): RigError {
  return new RigError("CANCELLED", "The operation was cancelled.", hint);
}
export function userCorrectable(code: string): boolean {
  return userCorrectableCodes.has(code);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One sentence a user can act on: message and hint for a RigError, the message otherwise; always ends with a period. */
/** The first problem in a JSON document that failed validation, as a predicate for a hint:
 * "has an invalid value at targets.0.plan: …" or "is not valid JSON (…)". */
export function describeInvalidDocument(
  error: unknown,
  schemaName: string,
): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (!issue) return `does not match the ${schemaName} schema`;
    const location = issue.path.length
      ? issue.path.map(String).join(".")
      : "the top level";
    return `has an invalid value at ${location}: ${issue.message}`;
  }
  return `is not valid JSON${error instanceof Error ? ` (${error.message})` : ""}`;
}
export function failureReason(error: unknown): string {
  const reason =
    error instanceof RigError
      ? `${error.message} ${error.hint}`
      : error instanceof Error
        ? error.message
        : String(error);
  return reason.endsWith(".") ? reason : `${reason}.`;
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
  return unexpectedFailure(failureCauses(error));
}
function unexpectedFailure(causes: FailureCauses): RigError {
  return new RigError(
    "UNEXPECTED",
    "Rig could not complete this operation.",
    "Inspect the diagnostic log for details.",
    {},
    causes,
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
  const causes = failureCauses(primary, recovery);
  try {
    const { code, message, hint, details } = asRigError(outcome);
    if (
      isDiagnosticCode(code) &&
      typeof message === "string" &&
      typeof hint === "string" &&
      typeof details === "object" &&
      details !== null &&
      !Array.isArray(details)
    )
      return new RigError(code, message, hint, details, causes);
  } catch {
    /* Every copied provider field is untrusted; retain original causal categories on projection failure. */
  }
  return unexpectedFailure(causes);
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
        case "PROCESS_EXITED":
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

/** The bounded, printable provider output a failure opted into sharing; anything else in its details stays out of diagnostics. */
export function diagnosticEvidence(error: unknown): string | undefined {
  try {
    if (error instanceof RigError) {
      const evidence = (error.details as { evidence?: unknown } | undefined)
        ?.evidence;
      if (typeof evidence === "string") return boundedEvidence(evidence);
    }
  } catch {
    /* Diagnostic preparation is best effort, including property inspection. */
  }
  return undefined;
}

/** Collapses whitespace and control characters and caps the text so a log line stays one readable record. */
export function boundedEvidence(text: string): string | undefined {
  const collapsed = text
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .trim()
    .slice(0, 500);
  return collapsed || undefined;
}

/** The last non-empty line of a command's output, which is where Caddy and most tools put the reason. */
export function lastOutputLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/** Inspect an untrusted failure without allowing its prototype or code getter to replace it. */
/** The same code the failure carries to the user, so a config problem is recorded as one and not as UNEXPECTED. */
export function diagnosticErrorCode(error: unknown): string {
  try {
    const code = asRigError(error).code;
    if (isDiagnosticCode(code)) return code;
  } catch {
    /* Diagnostic preparation is best effort, including property inspection. */
  }
  return "UNEXPECTED";
}

function isDiagnosticCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
}
