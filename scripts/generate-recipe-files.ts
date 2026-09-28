/** Writes src/recipes/generated-files.ts: the text of each file in src/recipes/files/, which recipes write into a Project.
 * The files stay real source files, type-checked and tested; the generated module carries their text into the rig
 * binary. Run with `bun run recipe-files`. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderRecipeFileModule } from "../src/recipes/file-module.js";

const output = join(
  import.meta.dir,
  "..",
  "src",
  "recipes",
  "generated-files.ts",
);
await writeFile(output, await renderRecipeFileModule());
process.stdout.write("wrote src/recipes/generated-files.ts\n");
