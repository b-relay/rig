/** Writes the editor JSON Schemas of rig.yaml and the Host config.yaml into schemas/. Run with `bun run schema`. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configJsonSchemas, renderJsonSchema } from "../src/config/index.js";

const directory = join(import.meta.dir, "..", "schemas");
await mkdir(directory, { recursive: true });
for (const [file, schema] of Object.entries(configJsonSchemas())) {
  await writeFile(join(directory, file), renderJsonSchema(schema));
  process.stdout.write(`wrote schemas/${file}\n`);
}
