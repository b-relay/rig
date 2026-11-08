import { z } from "zod";

// Kept apart from RigError, which every command loads, since this alone of the error helpers needs zod.

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
