import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { UserOutput } from "../cli/types";
import { RigError } from "../domain/errors";
import {
  applyConversion,
  previewConversion,
  rollbackConversion,
} from "./apply";
import type { ConversionDeps } from "./inventory";
import { reviewSchema, type Review } from "./review";

export interface CutoverDeps extends ConversionDeps {
  root: string;
  output: UserOutput;
}
const HELP: Record<string, string> = {
  "": `Usage: bun run cutover <command>

One-time conversion of a Rig root written before the configuration cutover. The root is RIG_ROOT, or ~/.rig.
Stop every Target and uninstall rigd with the runtime that started them first; nothing here stops a process.

Commands:
  inventory                                   What the root holds, read-only. Env files are never opened.
  preview --review <file>                     What a conversion under the review would do, read-only.
  apply --review <file> --revision <sha256>   Convert exactly the previewed revision, after an exact backup.
  rollback --backup <directory>               Put back what apply changed. Data is never touched.

Every command prints JSON and supports --help and -h.
`,
  inventory: `Usage: bun run cutover inventory

Prints what the root holds and what blocks a conversion, without a review: every hook is still undecided.
Reads metadata and registered Project configs only; records paths, names, commands and digests, never env-file values.
`,
  preview: `Usage: bun run cutover preview --review <file>

Prints the conversion the review leads to: every Target's mapping, blockers, candidate rig.yaml files, and the
revision that apply requires. Writes nothing.

The review is a YAML file:
  hooks:                                  one decision per hook, keyed <project>/<component or @project>/<hook>
    demo/web/preStart: { as: build }      it only compiles; it becomes the Service's build
    demo/web/postStop: { as: replaced, by: "what replaces it" }
  ambient: [USER]                         inherited names a command uses that you accept as unset
  activate: [demo]                        Projects you plan to activate first; recorded only
`,
  apply: `Usage: bun run cutover apply --review <file> --revision <sha256>

Converts the root if, and only if, it still matches the previewed revision and nothing blocks it. Writes an exact
backup first and prints its path. A root that is already converted is left unchanged.
`,
  rollback: `Usage: bun run cutover rollback --backup <directory>

Restores the metadata apply changed from the backup it printed, after verifying it. Refuses while a daemon or a
supervised process is alive on the root. Data, logs and sources are left as they are.
`,
};

/** The `cutover` command line. Every effect on the root happens in the conversion functions it calls. */
export async function runCutover(
  args: readonly string[],
  deps: CutoverDeps,
): Promise<number> {
  const [command = "", ...rest] = args,
    help = rest.includes("--help") || rest.includes("-h");
  if (command === "" || command === "--help" || command === "-h") {
    deps.output.write(HELP[""]!);
    return command === "" ? 1 : 0;
  }
  try {
    if (!["inventory", "preview", "apply", "rollback"].includes(command))
      throw usage(`Unknown cutover command ${JSON.stringify(command)}.`, "");
    if (help) {
      deps.output.write(HELP[command]!);
      return 0;
    }
    const flags = parseFlags(command, rest);
    let result: unknown;
    if (command === "inventory")
      result = await previewConversion(deps.root, reviewSchema.parse({}), deps);
    else if (command === "preview")
      result = await previewConversion(
        deps.root,
        await readReview(required(command, flags, "review")),
        deps,
      );
    else if (command === "apply")
      result = await applyConversion(
        deps.root,
        {
          review: await readReview(required(command, flags, "review")),
          expectedRevision: required(command, flags, "revision"),
        },
        deps,
      );
    else
      result = await rollbackConversion(
        deps.root,
        required(command, flags, "backup"),
        deps,
      );
    deps.output.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error) {
    if (!(error instanceof RigError)) throw error;
    deps.output.error(`${error.code}: ${error.message}\n${error.hint}\n`);
    return 1;
  }
}
const ALLOWED: Record<string, string[]> = {
  inventory: [],
  preview: ["review"],
  apply: ["review", "revision"],
  rollback: ["backup"],
};
function usage(message: string, command: string): RigError {
  return new RigError(
    "USAGE",
    message,
    `Run bun run cutover ${command ? `${command} ` : ""}--help.`,
  );
}
function parseFlags(
  command: string,
  args: readonly string[],
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!.replace(/^--/, ""),
      value = args[index + 1];
    if (
      !args[index]!.startsWith("--") ||
      !ALLOWED[command]!.includes(name) ||
      value === undefined ||
      flags.has(name)
    )
      throw usage(
        `Unexpected argument ${JSON.stringify(args[index])}.`,
        command,
      );
    flags.set(name, value);
  }
  return flags;
}
function required(
  command: string,
  flags: Map<string, string>,
  name: string,
): string {
  const value = flags.get(name);
  if (value === undefined) throw usage(`--${name} is required.`, command);
  return value;
}
async function readReview(path: string): Promise<Review> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new RigError(
      "CONVERSION_REVIEW",
      `The review file ${path} cannot be read.`,
      "Pass the path of the review YAML; bun run cutover preview --help shows its shape.",
      { path },
    );
  }
  let value: unknown;
  try {
    value = parse(text) ?? {};
  } catch {
    value = undefined;
  }
  const review = reviewSchema.safeParse(value);
  if (!review.success)
    throw new RigError(
      "CONVERSION_REVIEW",
      `The review file ${path} is not valid: ${review.error.issues[0]?.path.join(".")} ${review.error.issues[0]?.message}.`,
      "bun run cutover preview --help shows its shape.",
      { path },
    );
  return review.data;
}
