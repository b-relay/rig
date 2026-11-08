import { proxyModeOf } from "./proxy-schema";
import { checkedHostConfigSchema } from "./host-schema";
import {
  PATCH_BUILD_SHAPES,
  ROLE_SWITCH_SHAPES,
  projectFields,
  type ProjectConfig,
} from "./project-fields";
import { projectRuleIssues } from "./project-rules";
import { unsupportedShapeIssues } from "./retired-keys";
import { issuesError, validationError } from "./validation-messages";

// The config boundary: a Project or Host config document as written in, a checked config or one ConfigError out. Field
// schemas, cross-field rules, retired-key guidance and message wording each live in their own module; the Target roles and
// the patch rule, which planning reads without parsing, are in target-roles.ts and target-patch.ts.
export type { ProjectConfig } from "./project-fields";
export { TARGET_ROLES, targetOn, type TargetRole } from "./target-roles";
export { patchedSettings } from "./target-patch";

/** The unions whose own message names every shape a Project field accepts. */
const PROJECT_SHAPE_MESSAGES = [ROLE_SWITCH_SHAPES, PATCH_BUILD_SHAPES];
/** The Project schema: every documented field and the rules that span them. */
export const projectConfigSchema = projectFields.superRefine((config, ctx) => {
  for (const { path, message, rule } of projectRuleIssues(config))
    ctx.addIssue({
      code: "custom",
      path,
      message,
      ...(rule ? { params: { rule } } : {}),
    });
});
export function parseProjectConfig(value: unknown): ProjectConfig {
  const refused = unsupportedShapeIssues(value);
  if (refused.length) throw issuesError("Project", refused);
  const result = projectConfigSchema.safeParse(value);
  if (!result.success)
    throw validationError(
      "Project",
      result.error.issues,
      PROJECT_SHAPE_MESSAGES,
    );
  return result.data;
}
/** The parsed Host config plus how it publishes routes, which only the document as written can tell (see `proxyModeOf`). */
export function parseHostConfig(value: unknown) {
  const result = checkedHostConfigSchema.safeParse(value);
  if (!result.success) throw validationError("Host", result.error.issues, []);
  const { mode, externalIgnored } = proxyModeOf(value);
  return { ...result.data, proxyMode: mode, externalIgnored };
}
