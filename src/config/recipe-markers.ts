import { isMap, isScalar, type Document } from "yaml";
/** What a `# rig-recipe:` comment above a Service says about where the block came from. It is never read when a Target is
 * planned or run: a marker that cannot be understood is kept as `malformed` for a report to mention, not refused. */
export type RecipeMarker =
  | {
      readonly service: string;
      readonly recipe: string;
      readonly version: number;
      /** The Service name the block was generated for. */
      readonly name?: string;
    }
  | { readonly service: string; readonly malformed: string };
const MARKER = /^#\s*rig-recipe:/;
const RECOGNIZED =
  /^#\s*rig-recipe:\s*([a-z][a-z0-9-]*)@([1-9][0-9]{0,5})(?:\s+name=(\S+))?\s*$/;
/** The provenance comment that `renderRecipe` writes and `recipeMarkers` reads. */
export function markerComment(recipe: string, version: number, name: string) {
  return `# rig-recipe: ${recipe}@${version} name=${name}`;
}
/** Pure: the markers in the comment lines directly above each Service key of a parsed document and its source text. */
export function recipeMarkers(document: Document, raw: string): RecipeMarker[] {
  const services = document.get("services");
  if (!isMap(services)) return [];
  const markers: RecipeMarker[] = [];
  for (const { key } of services.items) {
    if (!isScalar(key) || typeof key.value !== "string" || !key.range) continue;
    const above = raw.slice(0, key.range[0]).split("\n").slice(0, -1);
    const found: string[] = [];
    for (let at = above.length - 1; at >= 0; at--) {
      const line = above[at]!.trim();
      if (!line.startsWith("#")) break;
      if (MARKER.test(line)) found.push(line);
    }
    if (!found.length) continue;
    const match = found.length === 1 ? RECOGNIZED.exec(found[0]!) : null;
    markers.push(
      match
        ? {
            service: key.value,
            recipe: match[1]!,
            version: Number(match[2]),
            ...(match[3] === undefined ? {} : { name: match[3] }),
          }
        : { service: key.value, malformed: found.reverse().join(" ") },
    );
  }
  return markers;
}
