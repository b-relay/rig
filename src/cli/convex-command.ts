import { CommanderError, type Command } from "commander";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { RigError, errorMessage } from "../domain/errors";
import type { ConvexCommandOptions } from "../helpers/convex-contracts";
import { backendRelease } from "../helpers/convex-deployment";
import { isHelp } from "./failure";
import { addHelpCommand, terminalCommand } from "./commands";
import { terminalText } from "./terminal-text";
import type { UserOutput } from "./types";

/** The name a new deployment gets when --instance-name is not given; Convex's own self-hosted default. */
export const DEFAULT_INSTANCE_NAME = "convex-self-hosted";
const PORT = "must be a port number from 1 to 65535";
const port = z.coerce
  .number({ error: PORT })
  .int(PORT)
  .min(1, PORT)
  .max(65535, PORT);
const options = z
  .object({
    cloudPort: port,
    sitePort: port,
    stateDir: z
      .string()
      .refine(
        isAbsolute,
        "must be an absolute path, such as ${rig.data}/backend",
      ),
    instanceName: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]{0,63}$/,
        "must be lowercase letters, digits and '-', starting with a letter or digit",
      ),
    backendVersion: backendRelease.optional(),
  })
  .refine((value) => value.cloudPort !== value.sitePort, {
    message: "must differ from --cloud-port",
    path: ["sitePort"],
  });
const FLAGS: Record<string, string> = {
  cloudPort: "--cloud-port",
  sitePort: "--site-port",
  stateDir: "--state-dir",
  instanceName: "--instance-name",
  backendVersion: "--backend-version",
};
/** Adds `convex` to a `rigd` command. `run` receives the checked options and returns the exit code the command ends with. */
export function addConvexCommand(
  command: Command,
  run: (options: ConvexCommandOptions) => Promise<number>,
  setExitCode: (code: number) => void,
): void {
  command
    .command("convex")
    .description(
      "Run a local Convex backend on 127.0.0.1 and keep convex dev pushing the Project's functions to it. The convex recipe's Service runs this through ${rig.rigd}; it reads no Rig state.",
    )
    .requiredOption(
      "--cloud-port <port>",
      "Loopback port for the backend's API",
    )
    .requiredOption(
      "--site-port <port>",
      "Loopback port for the backend's HTTP actions",
    )
    .requiredOption(
      "--state-dir <dir>",
      "Absolute directory that keeps the deployment (config.json, database, file storage); the recipe uses the Service's persistent data",
    )
    .option(
      "--instance-name <name>",
      "Name of a new deployment; an existing one keeps its own",
      DEFAULT_INSTANCE_NAME,
    )
    .option(
      "--backend-version <release>",
      "Run this backend release instead of the one Convex recommends, such as precompiled-2026-09-21-0cf49cb",
    )
    .argument(
      "[convex-dev-args...]",
      "Arguments for convex dev, after --, such as -- --typecheck disable",
    )
    .addHelpText(
      "after",
      "\nThe backend binary comes from Convex's cache (~/.cache/convex/binaries), which convex dev shares; a missing\nrelease is downloaded from GitHub, which needs the network and unzip. .env.local in the working directory is\npointed at the backend (CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY), so other bunx convex commands\nreach it, unless a deploy key in .env or the shell sends them to Convex Cloud, which the Convex CLI prefers.\nA deployment convex dev --local left in .convex/local/default is copied into --state-dir the first time.\n",
    )
    .action(async (operands: string[], raw: Record<string, unknown>) => {
      setExitCode(await run(checkedOptions(raw, operands)));
    });
}
/** `rigd convex` on its own: parsed and reported without the Rig root, since it runs as a Service's process, where
 * RIG_ROOT is not set. A failure is its message and hint on stderr, which the Target log records. */
export async function runConvexCli(
  args: readonly string[],
  dependencies: {
    output: UserOutput;
    run: (options: ConvexCommandOptions) => Promise<number>;
  },
): Promise<number> {
  const command = terminalCommand("rigd", dependencies.output);
  let exitCode = 0;
  addConvexCommand(command, dependencies.run, (code) => (exitCode = code));
  addHelpCommand(command, "rigd");
  try {
    await command.parseAsync([...args], { from: "user" });
    return exitCode;
  } catch (error) {
    if (isHelp(error)) return 0;
    const failure =
      error instanceof CommanderError
        ? new RigError(
            "USAGE",
            error.message.replace(/^error:\s*/i, ""),
            "Run rigd convex --help.",
          )
        : error instanceof RigError
          ? error
          : new RigError(
              "UNEXPECTED",
              errorMessage(error),
              "The output above this line in the Target log shows what rigd convex was doing.",
            );
    dependencies.output.error(
      `rigd convex: ${terminalText(failure.message)} (${failure.code})\n${terminalText(failure.hint)}\n`,
    );
    return 1;
  }
}
function checkedOptions(
  raw: Record<string, unknown>,
  operands: readonly string[],
): ConvexCommandOptions {
  const parsed = options.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const flag = FLAGS[String(issue.path[0])] ?? "An option";
    throw new RigError(
      "USAGE",
      `${flag} ${issue.message}.`,
      "Run rigd convex --help.",
    );
  }
  return {
    ...parsed.data,
    ...(parsed.data.backendVersion === undefined
      ? {}
      : { backendVersion: parsed.data.backendVersion }),
    devArguments: [...operands],
  };
}
