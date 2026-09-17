import { stringify } from "yaml";
import { markerComment } from "../config/recipe-markers";
import type { Recipe, RecipeVersion } from "./catalog";
/** Pure: the text to paste under `services:` — the provenance comment, then the Service under `name`, indented as a
 * `services` entry. Long commands stay on one line so the block reads back exactly as the recipe states it. */
export function renderRecipe(
  recipe: Recipe,
  version: RecipeVersion,
  name: string,
): string {
  const block = stringify({ [name]: version.service(name) }, { lineWidth: 0 });
  return `${markerComment(recipe.name, version.version, name)}\n${block}`
    .trimEnd()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
    .concat("\n");
}
