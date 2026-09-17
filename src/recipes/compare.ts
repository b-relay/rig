import { parseProjectConfig } from "../config/schema";
import type { ProjectConfig, RecipeMarker } from "../config/types";
import { latest, type Recipe } from "./catalog";
/** One field that differs, by its path inside the Service (`env.PGDATA`); a side that lacks the field has no value. */
export interface RecipeChange {
  readonly path: string;
  readonly from?: string;
  readonly to?: string;
}
/** What can be said about one marked Service. Only `compared` claims anything about the block itself, and it claims only
 * what the configuration says: never that the Service runs, or is healthy. */
export type RecipeFinding =
  | {
      readonly service: string;
      readonly status: "malformed";
      readonly marker: string;
    }
  | {
      readonly service: string;
      readonly status: "unknown-recipe" | "unknown-version";
      readonly recipe: string;
      readonly version: number;
    }
  | {
      readonly service: string;
      readonly status: "compared";
      readonly recipe: string;
      readonly version: number;
      readonly bundled: number;
      /** The name in the marker, when the Service is no longer called that. */
      readonly generatedAs?: string;
      /** The user's Service against the version it was generated from. */
      readonly customized: readonly RecipeChange[];
      /** The version it was generated from against the bundled one; empty when they are the same version. */
      readonly update: readonly RecipeChange[];
    };
/** Pure: compares every marked Service of one document with the catalog. Both sides pass through the config parser, so a
 * difference in spelling that the parser does not keep is not a difference. */
export function compareRecipes(
  document: { config: ProjectConfig; recipeMarkers?: readonly RecipeMarker[] },
  catalog: readonly Recipe[],
): RecipeFinding[] {
  return (document.recipeMarkers ?? []).map((marker): RecipeFinding => {
    if ("malformed" in marker)
      return {
        service: marker.service,
        status: "malformed",
        marker: marker.malformed,
      };
    const { service, recipe: recipeName, version } = marker;
    const recipe = catalog.find(({ name }) => name === recipeName);
    const origin = recipe?.versions.find((known) => known.version === version);
    if (!recipe || !origin)
      return {
        service,
        status: recipe ? "unknown-version" : "unknown-recipe",
        recipe: recipeName,
        version,
      };
    const generated = fields(parsed(service, origin.service(service)));
    return {
      service,
      status: "compared",
      recipe: recipeName,
      version,
      bundled: latest(recipe).version,
      ...(marker.name !== undefined && marker.name !== service
        ? { generatedAs: marker.name }
        : {}),
      customized: changes(
        generated,
        fields(document.config.services?.[service]),
      ),
      update: changes(
        generated,
        fields(parsed(service, latest(recipe).service(service))),
      ),
    };
  });
}
function parsed(name: string, service: Readonly<Record<string, unknown>>) {
  return parseProjectConfig({ name: "recipe", services: { [name]: service } })
    .services![name];
}
/** Leaf values by dotted path; a list is one value, because its order is its meaning. */
function fields(value: unknown, at = ""): Map<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return new Map(
      value === undefined
        ? []
        : [[at, typeof value === "string" ? value : JSON.stringify(value)]],
    );
  const found = new Map<string, string>();
  for (const [key, inner] of Object.entries(value))
    for (const [path, leaf] of fields(inner, at ? `${at}.${key}` : key))
      found.set(path, leaf);
  return found;
}
function changes(
  from: Map<string, string>,
  to: Map<string, string>,
): RecipeChange[] {
  return [...new Set([...from.keys(), ...to.keys()])]
    .filter((path) => from.get(path) !== to.get(path))
    .map((path) => ({
      path,
      ...(from.has(path) ? { from: from.get(path)! } : {}),
      ...(to.has(path) ? { to: to.get(path)! } : {}),
    }));
}
