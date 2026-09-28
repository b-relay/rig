import { stringify } from "yaml";
import { markerComment } from "../config/recipe-markers";
import type { ConfigFormat } from "../config/formats";
import { recipeService, type Recipe, type RecipeVersion } from "./catalog";
/** Pure: the text to paste under `services:` of a rig.yaml in `format` — the provenance comment, then the Service under
 * `name` in that format's spelling, indented as a `services` entry. Long commands stay on one line so the block reads back
 * exactly as the recipe states it. */
export function renderRecipe(
  recipe: Recipe,
  version: RecipeVersion,
  name: string,
  format: ConfigFormat,
): string {
  const block = stringify(
    { [name]: recipeService(version, name, format) },
    { lineWidth: 0 },
  );
  return `${markerComment(recipe.name, version.version, name)}\n${block}`
    .trimEnd()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
    .concat("\n");
}
