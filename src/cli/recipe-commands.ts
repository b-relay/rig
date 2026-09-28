import type { Command } from "commander";
import { RigError } from "../domain/errors";
import { latest, type Recipe, type RecipeVersion } from "../recipes/catalog";
import { renderRecipe } from "../recipes/render";
import type { ExecuteCommand } from "./commands";
import { terminalText } from "./terminal-text";
import type { ProjectFiles, UserOutput } from "./types";
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** `list` and `generate` need no rigd. `list` only reads the catalog; `generate` prints the Service block and writes the
 * recipe's own files, if it has any, into the Project directory (see `writeRecipeFiles`). `diff` reads the Project's
 * document and files, which rigd does. */
export function addRecipeCommands(
  command: Command,
  {
    cwd,
    output,
    recipes,
    execute,
    projectScope,
    projectFiles,
  }: {
    cwd: string;
    output: UserOutput;
    recipes: readonly Recipe[];
    execute: ExecuteCommand;
    /** The grammar's one check of a --project value. */
    projectScope(options: { project?: string }): { project?: string };
    projectFiles?: ProjectFiles;
  },
): void {
  const recipe = command
    .command("recipe")
    .description(
      "Copy a bundled Service recipe into rig.yaml and compare it later.",
    );
  recipe
    .command("list")
    .description("List the bundled recipes and their versions.")
    .action(() =>
      output.write(
        recipes
          .map(
            (each) =>
              `${each.name}@${latest(each).version}  ${each.summary}\n  rig recipe generate ${each.name}  (Service name: ${each.defaultName})\n`,
          )
          .join(""),
      ),
    );
  recipe
    .command("generate")
    .description(
      "Print a recipe as a Service block to paste under services: in rig.yaml, and write the files the recipe's Service runs into the Project (never over a file that differs).",
    )
    .argument("<recipe>", "Recipe name, or name@version for an older one")
    .option("--name <service>", "Service name to generate the block for")
    .action(async (selector: string, options: { name?: string }) => {
      const [name, version] = selector.split("@", 2);
      const found = recipes.find((each) => each.name === name);
      const chosen =
        found && version === undefined
          ? latest(found)
          : found?.versions.find((each) => String(each.version) === version);
      if (!found || !chosen)
        throw new RigError(
          "USAGE",
          found
            ? `${found.name} has no version '${terminalText(version ?? "")}'.`
            : `There is no recipe named '${terminalText(name ?? "")}'.`,
          found
            ? `Bundled versions: ${found.versions.map((each) => each.version).join(", ")}.`
            : "Run rig recipe list to see the bundled recipes.",
        );
      const service = serviceName(options.name ?? found.defaultName);
      output.write(renderRecipe(found, chosen, service));
      await writeRecipeFiles(found, chosen, service, {
        cwd,
        output,
        projectFiles,
      });
      if (chosen !== latest(found) && chosen.notice)
        output.error(
          `Warning: ${chosen.notice} Run rig recipe generate ${found.name} for ${found.name}@${latest(found).version}.\n`,
        );
    });
  recipe
    .command("diff")
    .description(
      "Compare the Project's recipe Services with the bundled recipes. rig.yaml is only read.",
    )
    .argument("[service]", "Compare only this Service")
    .option("--project <name>", "Registered Project identity")
    .action((service: string | undefined, options: { project?: string }) =>
      execute({
        action: "recipe-diff",
        repoPath: cwd,
        ...projectScope(options),
        ...(service === undefined ? {} : { serviceName: serviceName(service) }),
      }),
    );
}

/** Writes each file of `version` into the Project directory unless it is already there. A file that is there with the
 * same content is left as it is; one that differs is never overwritten: that fails RECIPE_FILE_CHANGED, after the other
 * files are handled, pointing at `rig recipe diff`. Says on stderr what it wrote, so stdout stays the block to paste. */
async function writeRecipeFiles(
  recipe: Recipe,
  version: RecipeVersion,
  service: string,
  input: { cwd: string; output: UserOutput; projectFiles?: ProjectFiles },
): Promise<void> {
  if (!version.files?.length) return;
  const files = input.projectFiles;
  if (!files)
    throw new RigError(
      "RECIPE_FILES_UNAVAILABLE",
      `${recipe.name}@${version.version} writes files into the Project, and this rig cannot write files.`,
      "Run rig recipe generate from the installed rig in the Project directory.",
    );
  const directory = await files.projectDirectory(input.cwd);
  const changed: string[] = [];
  for (const file of version.files) {
    const existing = await files.read(directory, file.path);
    if (existing === undefined) {
      await files.create(directory, file.path, file.content);
      input.output.error(
        `Wrote ${file.path} in ${directory}; commit it with the Project. The Service runs it.\n`,
      );
    } else if (existing === file.content)
      input.output.error(
        `${file.path} in ${directory} is already ${recipe.name}@${version.version}'s copy.\n`,
      );
    else changed.push(file.path);
  }
  if (changed.length)
    throw new RigError(
      "RECIPE_FILE_CHANGED",
      `${changed.join(", ")} in ${directory} ${changed.length === 1 ? "differs" : "differ"} from ${recipe.name}@${version.version}'s copy and ${changed.length === 1 ? "was" : "were"} not overwritten.`,
      `Run rig recipe diff ${service} to compare. To take Rig's copy, move yours aside and run rig recipe generate again.`,
      { files: changed },
    );
}
/** Refuses text that cannot be a Service key before it is sent anywhere or echoed back. */
function serviceName(text: string): string {
  if (!SERVICE_NAME.test(text))
    throw new RigError(
      "USAGE",
      `'${terminalText(text)}' is not a Service name.`,
      "Use lowercase letters, digits or '-', starting with a letter or digit.",
    );
  return text;
}
