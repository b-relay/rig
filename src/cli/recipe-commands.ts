import type { Command } from "commander";
import { RigError } from "../domain/errors";
import { latest, type Recipe } from "../recipes/catalog";
import { renderRecipe } from "../recipes/render";
import type { ExecuteCommand } from "./commands";
import { terminalText } from "./terminal-text";
import type { UserOutput } from "./types";
import {
  CONFIG_FORMATS,
  LATEST_FORMAT,
  deprecationLine,
  isConfigFormat,
  isDeprecatedFormat,
  type ConfigFormat,
  type FoundFormat,
} from "../config/formats";
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** `list` and `generate` only read the catalog and write text: they need no rigd and no Project, and `generate` reads at
 * most the `format` of the rig.yaml it would be pasted into. `diff` reads the Project's document, which rigd does. */
export function addRecipeCommands(
  command: Command,
  {
    cwd,
    output,
    recipes,
    execute,
    projectScope,
    configFormat,
  }: {
    cwd: string;
    output: UserOutput;
    recipes: readonly Recipe[];
    execute: ExecuteCommand;
    /** The format of the rig.yaml found from `cwd`, when there is one. */
    configFormat?: (cwd: string) => Promise<FoundFormat | undefined>;
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
    .option(
      "--format <format>",
      `rig.yaml format to write the block in (${CONFIG_FORMATS.join(", ")}); default: the format of the rig.yaml found from the current directory, else ${LATEST_FORMAT}`,
    )
    .action(
      async (selector: string, options: { name?: string; format?: string }) => {
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
        const project = await configFormat?.(cwd).catch(() => undefined);
        const format =
          options.format === undefined
            ? (project?.format ?? LATEST_FORMAT)
            : requestedFormat(options.format);
        output.write(renderRecipe(found, chosen, service, format));
        // Like every command run in a Project whose rig.yaml is older, one line says so.
        if (project && isDeprecatedFormat(project.format))
          output.error(
            `Deprecated: ${terminalText(deprecationLine(project.path, project.format))}\n`,
          );
      },
    );
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

function requestedFormat(text: string): ConfigFormat {
  if (isConfigFormat(text)) return text;
  throw new RigError(
    "USAGE",
    `'${terminalText(text)}' is not a rig.yaml format.`,
    `Use one of ${CONFIG_FORMATS.join(", ")}.`,
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
