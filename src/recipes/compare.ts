import { parseProjectConfig } from "../config/schema";
import type { ProjectConfig, RecipeMarker } from "../config/types";
import {
  LATEST_FORMAT,
  UNDECLARED_FORMAT,
  servicePathIn,
  type ConfigFormat,
} from "../config/formats";
import { latest, type Recipe, type RecipeVersion } from "./catalog";
import type { RecipeFileFinding } from "./files";
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
      /** The catalog's notice on the version it was generated from, when that version has one. */
      readonly notice?: string;
      /** The files the bundled version writes into the Project, compared with the Project's copies; see
       * `withRecipeFiles`. Absent when not compared, or when the recipe writes none. */
      readonly files?: readonly RecipeFileFinding[];
    };
/** Pure: compares every marked Service of one document with the catalog. Both sides pass through the config parser, so a
 * difference in spelling that the parser does not keep is not a difference, nor is the format a recipe or the document is
 * written in. Each changed field is named the way the document's format spells it. */
export function compareRecipes(
  document: {
    config: ProjectConfig;
    recipeMarkers?: readonly RecipeMarker[];
    format?: ConfigFormat;
  },
  catalog: readonly Recipe[],
): RecipeFinding[] {
  const spelled = (list: RecipeChange[]) =>
    list.map((change) => ({
      ...change,
      path: servicePathIn(
        document.format ?? LATEST_FORMAT,
        change.path.split("."),
      ).join("."),
    }));
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
    const generated = fields(parsed(service, origin));
    return {
      service,
      status: "compared",
      recipe: recipeName,
      version,
      bundled: latest(recipe).version,
      ...(marker.name !== undefined && marker.name !== service
        ? { generatedAs: marker.name }
        : {}),
      customized: spelled(
        changes(generated, fields(document.config.services?.[service])),
      ),
      update: spelled(
        changes(generated, fields(parsed(service, latest(recipe)))),
      ),
      ...(origin.notice === undefined ? {} : { notice: origin.notice }),
    };
  });
}
/** One recipe version's Service under `name`, as the config parser reads it in the format the version is written in. */
function parsed(name: string, version: RecipeVersion) {
  return parseProjectConfig({
    format: version.format ?? UNDECLARED_FORMAT,
    name: "recipe",
    services: { [name]: version.service(name) },
  }).services![name];
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
