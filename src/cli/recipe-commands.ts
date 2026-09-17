import type { Command } from "commander";
import { RigError } from "../domain/errors";
import { latest, type Recipe } from "../recipes/catalog";
import { renderRecipe } from "../recipes/render";
import type { ExecuteCommand } from "./commands";
import { terminalText } from "./terminal-text";
import type { UserOutput } from "./types";
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** `list` and `generate` only read the catalog and write text: they need no rigd, no Project and no file. `diff` reads the
 * Project's document, which rigd does. */
export function addRecipeCommands(
  command: Command,
  {
    cwd,
    output,
    recipes,
    execute,
    projectScope,
  }: {
    cwd: string;
    output: UserOutput;
    recipes: readonly Recipe[];
    execute: ExecuteCommand;
    /** The grammar's one check of a --project value. */
    projectScope(options: { project?: string }): { project?: string };
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
      "Print a recipe as a Service block to paste under services: in rig.yaml. Nothing is written.",
    )
    .argument("<recipe>", "Recipe name, or name@version for an older one")
    .option("--name <service>", "Service name to generate the block for")
    .action((selector: string, options: { name?: string }) => {
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
      const service = options.name ?? found.defaultName;
      if (!SERVICE_NAME.test(service))
        throw new RigError(
          "USAGE",
          `'${terminalText(service)}' is not a Service name.`,
          "Use lowercase letters, digits or '-', starting with a letter or digit.",
        );
      output.write(renderRecipe(found, chosen, service));
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
        ...(service === undefined ? {} : { serviceName: service }),
      }),
    );
}
