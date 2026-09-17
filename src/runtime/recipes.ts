import type { ConfigDocument, ProjectConfig } from "../config/types";
import { RigError } from "../domain/errors";
import { BUNDLED_RECIPES, type Recipe } from "../recipes/catalog";
import { compareRecipes, type RecipeFinding } from "../recipes/compare";
export interface RecipeReport {
  project: string;
  /** The document that was compared, so the user knows which file the report is about. */
  path: string;
  findings: RecipeFinding[];
}
/** Pure: the comparison of one already-read document, optionally narrowed to one Service. A Service without a marker is
 * not a finding: Rig cannot tell a hand-written Service from a recipe whose comment was removed, and says so when asked about one. */
export function recipeReport(
  project: string,
  document: ConfigDocument<ProjectConfig>,
  selection: { serviceName?: string },
  catalog: readonly Recipe[] = BUNDLED_RECIPES,
): RecipeReport {
  const findings = compareRecipes(document, catalog);
  const { serviceName } = selection;
  if (serviceName === undefined)
    return { project, path: document.path, findings };
  if (!Object.hasOwn(document.config.services ?? {}, serviceName))
    throw new RigError(
      "SERVICE_UNKNOWN",
      `${project} has no Service named '${serviceName}'.`,
      "Run rig config to see the Project's Services.",
      { service: serviceName },
    );
  const narrowed = findings.filter(({ service }) => service === serviceName);
  if (!narrowed.length)
    throw new RigError(
      "RECIPE_UNMARKED",
      `${serviceName} has no rig-recipe comment, so there is nothing to compare it with.`,
      "Only a Service that still carries the comment written by rig recipe generate can be compared.",
      { service: serviceName },
    );
  return { project, path: document.path, findings: narrowed };
}
/** Pure: what doctor mentions. A comparison that found the bundled version says nothing, customized or not: a user's own
 * changes are theirs. None of these says anything about a running Service. */
export function recipeNotices(findings: readonly RecipeFinding[]): string[] {
  return findings.flatMap((finding) => {
    const { service } = finding;
    if (finding.status === "malformed")
      return [
        `${service}: the recipe comment '${finding.marker}' is not in a form Rig writes, so the Service cannot be compared with a bundled recipe.`,
      ];
    if (finding.status === "unknown-recipe")
      return [
        `${service}: marked as generated from ${finding.recipe}@${finding.version}, which is not a recipe bundled with this Rig.`,
      ];
    if (finding.status === "unknown-version")
      return [
        `${service}: marked as generated from ${finding.recipe}@${finding.version}, a version this Rig does not bundle.`,
      ];
    if (finding.status !== "compared") return [];
    return finding.version === finding.bundled
      ? []
      : [
          `${service}: generated from ${finding.recipe}@${finding.version}; ${finding.recipe}@${finding.bundled} is bundled. Run rig recipe diff ${service} to compare.`,
        ];
  });
}
