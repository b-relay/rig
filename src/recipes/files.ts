import { latest, type Recipe } from "./catalog";
import type { RecipeFinding } from "./compare";
import { lineDiff } from "./text-diff";

/** The most diff lines a finding carries; the rest are counted. */
const MAX_DIFF_LINES = 400;
/** A file a recipe writes into the Project, compared with the Project's copy. */
export interface RecipeFileFinding {
  /** Relative to the Project directory. */
  readonly path: string;
  /** The recipe version whose copy it was compared with: the bundled (latest) one. */
  readonly bundled: number;
  readonly state: "missing" | "same" | "differs";
  /** Whether the version the Service was generated from writes this file too, so the Service runs it. */
  readonly used: boolean;
  /** For `differs`: the Project's copy against Rig's, as unified-diff lines (`-` the Project's, `+` Rig's). */
  readonly diff?: readonly string[];
  /** Diff lines left out past MAX_DIFF_LINES. */
  readonly omitted?: number;
}
/** Each compared finding with `files`: every file its recipe's bundled version writes, read from the Project through
 * `read` (a path relative to the Project directory; undefined when there is no such file). Other findings are
 * returned as they are. */
export async function withRecipeFiles(
  findings: readonly RecipeFinding[],
  catalog: readonly Recipe[],
  read: (path: string) => Promise<string | undefined>,
): Promise<RecipeFinding[]> {
  return await Promise.all(
    findings.map(async (finding) => {
      if (finding.status !== "compared") return finding;
      const recipe = catalog.find(({ name }) => name === finding.recipe)!;
      const bundled = latest(recipe);
      if (!bundled.files?.length) return finding;
      const origin = recipe.versions.find(
        ({ version }) => version === finding.version,
      );
      const files = await Promise.all(
        bundled.files.map(async (file): Promise<RecipeFileFinding> => {
          const used =
            origin?.files?.some(({ path }) => path === file.path) === true;
          const copy = await read(file.path);
          if (copy === undefined)
            return {
              path: file.path,
              bundled: bundled.version,
              state: "missing",
              used,
            };
          if (copy === file.content)
            return {
              path: file.path,
              bundled: bundled.version,
              state: "same",
              used,
            };
          const diff = lineDiff(copy, file.content);
          return {
            path: file.path,
            bundled: bundled.version,
            state: "differs",
            used,
            diff: diff.slice(0, MAX_DIFF_LINES),
            ...(diff.length > MAX_DIFF_LINES
              ? { omitted: diff.length - MAX_DIFF_LINES }
              : {}),
          };
        }),
      );
      return { ...finding, files };
    }),
  );
}
