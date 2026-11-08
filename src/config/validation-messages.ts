import type { z } from "zod";
import { ConfigError } from "./errors";
import { isRecord } from "./record";

// How a refused config document is told to its author: Zod's issues in words a user can act on, as one ConfigError.

/** One reported problem of a config document. `rule` marks a kind of problem a caller treats on its own. */
export interface Issue {
  path: string[];
  message: string;
  rule?: typeof RENAMED_RULE;
}
/** A key or reference path written under a name ADR 0011 or 0012 replaced with its Compose name, such as `run`,
 * `${env.X}` or `ready`. */
export const RENAMED_RULE = "renamed";
/** Human guidance contains field paths and plain rules, never input values. `shapeMessages` are the messages of the
 * unions whose own message names every shape they accept, so a value of none of them is explained by it. */
export function validationError(
  scope: string,
  issues: readonly z.core.$ZodIssue[],
  shapeMessages: readonly string[],
): ConfigError {
  const safe = (value: string) =>
    value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
  return issuesError(
    scope,
    issues.map((issue) => {
      const explained = explainIssue(issue, shapeMessages);
      const rule =
        issue.code === "custom" && issue.params?.rule === RENAMED_RULE
          ? RENAMED_RULE
          : undefined;
      return {
        path: explained.path.map((part) => safe(String(part))),
        message: safe(explained.message),
        ...(rule ? { rule } : {}),
      };
    }),
  );
}
/** Whether a refused config was refused, at least in part, because it uses names from before ADR 0011 or 0012: a rig.yaml
 * committed before the rename, which a deployed revision may still hold. */
export function usesRenamedKeys(error: ConfigError): boolean {
  const issues = error.context.issues;
  return (
    Array.isArray(issues) &&
    issues.some(
      (issue: unknown) =>
        isRecord(issue) && (issue as Partial<Issue>).rule === RENAMED_RULE,
    )
  );
}
/** One ConfigError for a document's problems: every issue in its context, the first three in its hint. */
export function issuesError(
  scope: string,
  details: readonly Issue[],
): ConfigError {
  const hint =
    "Fix " +
    details
      .slice(0, 3)
      .map(
        (issue) =>
          `${issue.path.join(".") || "config"}: ${issue.message.replace(/\.$/, "")}`,
      )
      .join("; ") +
    ".";
  return new ConfigError(
    `Invalid ${scope} configuration.`,
    "invalid_config",
    { issues: details },
    hint.slice(0, 900),
  );
}
/** A union failure is explained by the branch the input came closest to: the one whose
 * discriminator matched and which raised the fewest problems, with the field path joined. */
function explainIssue(
  issue: z.core.$ZodIssue,
  shapeMessages: readonly string[],
): {
  path: PropertyKey[];
  message: string;
} {
  if (issue.code === "invalid_union" && issue.errors.length) {
    const branches = issue.errors.filter((branch) => branch.length);
    // A value of none of the shapes a union names in its own message, such as a Target switch that is neither a boolean
    // nor a map, is explained by that message.
    if (
      shapeMessages.includes(issue.message) &&
      branches.length &&
      branches.every(
        (branch) =>
          branch.length === 1 &&
          (branch[0]!.code === "invalid_type" ||
            branch[0]!.code === "invalid_value") &&
          branch[0]!.path.length === 0,
      )
    )
      return { path: [...issue.path], message: issue.message };
    const discriminators = branches.map((branch) =>
      branch[0]!.code === "invalid_value" ? branch[0] : undefined,
    );
    // Every branch rejected its own kind marker: the input chose no kind at all.
    if (branches.length && discriminators.every(Boolean)) {
      const choices = new Map<string, Set<string>>();
      for (const marker of discriminators) {
        const field = marker!.path.join(".");
        const values = choices.get(field) ?? new Set<string>();
        for (const value of marker!.values) values.add(JSON.stringify(value));
        choices.set(field, values);
      }
      return {
        path: [...issue.path],
        message: `must set ${[...choices]
          .map(
            ([field, values]) => `${field} to one of ${[...values].join(", ")}`,
          )
          .join(" or ")}`,
      };
    }
    // On a tie, the branch whose problem lies deeper is the one the input's own shape chose: a settings map with one bad
    // field is explained by that field, not by the boolean it is not.
    const nearest = [...branches].sort(
      (a, b) =>
        Number(a[0]!.code === "invalid_value") -
          Number(b[0]!.code === "invalid_value") ||
        a.length - b.length ||
        b[0]!.path.length - a[0]!.path.length,
    )[0];
    if (nearest) {
      const inner = explainIssue(nearest[0]!, shapeMessages);
      return { path: [...issue.path, ...inner.path], message: inner.message };
    }
  }
  return { path: [...issue.path], message: describeIssue(issue) };
}
/** The rule a field broke, in words a user can act on; Zod's own text names patterns and internals. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const quoted = (values: readonly unknown[]) =>
    values.map((value) => JSON.stringify(value)).join(", ");
  switch (issue.code) {
    case "unrecognized_keys":
      return `has no field named ${quoted(issue.keys)}`;
    case "invalid_type":
      return issue.expected === "nonoptional"
        ? "is required"
        : `must be ${/^[aeiou]/.test(issue.expected) ? "an" : "a"} ${issue.expected}`;
    case "invalid_value":
      return `must be one of ${quoted(issue.values)}`;
    case "too_small":
      return issue.origin === "string"
        ? issue.minimum === 1
          ? "must not be empty"
          : `must have at least ${issue.minimum} characters`
        : issue.origin === "array"
          ? `must list at least ${issue.minimum} entries`
          : `must be at least ${issue.minimum}`;
    case "too_big":
      return issue.origin === "string"
        ? `must have at most ${issue.maximum} characters`
        : issue.origin === "array"
          ? `must list at most ${issue.maximum} entries`
          : `must be at most ${issue.maximum}`;
    case "invalid_key":
      return issue.issues[0] ? describeIssue(issue.issues[0]) : issue.message;
    case "invalid_format":
      return /^Invalid /.test(issue.message)
        ? "does not have the expected format"
        : issue.message;
    default:
      return issue.message;
  }
}
