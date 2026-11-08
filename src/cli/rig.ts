import { RigError } from "../domain/errors";
import type { CliDependencies, UserOutput } from "./types";
import { commandPath, createRigCommand, type ExecuteCommand } from "./commands";
import { isHelp, reportDetached, reportFailure } from "./failure";
import { namesRead, requestsJson } from "./structured-reads";

/** Parse and render one invocation; the injected client owns runtime effects. */
export async function runRigCli(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  let operationId: string | undefined;
  // Set from the arguments once the grammar exists, then by the command that runs.
  let json = false;
  let exitCode = 0;
  const execute: ExecuteCommand = async (request, options = {}) => {
    json = options.json === true;
    // Assigned before preflight so a failure while gathering answers still names the Operation.
    operationId = dependencies.newOperationId();
    // What runs a command and renders its answer loads once one is chosen: help and usage errors need none of it.
    const { executeCommand } = await import("./execution");
    exitCode = await executeCommand(
      request,
      options,
      operationId,
      dependencies,
    );
  };
  const command = createRigCommand(
    dependencies.cwd,
    dependencies.output,
    execute,
    dependencies.now,
    dependencies.local,
    {
      read: (request) =>
        dependencies.client.command(request, dependencies.signal),
      ...(dependencies.interaction
        ? { interaction: dependencies.interaction }
        : {}),
    },
  );
  const read = namesRead(command, args);
  json = read && requestsJson(args);
  try {
    await command.parseAsync(args.length ? [...args] : ["--help"], {
      from: "user",
    });
    return exitCode;
  } catch (error) {
    if (isHelp(error)) return 0;
    if (error instanceof RigError && error.code === "DETACHED" && operationId)
      return reportDetached(operationId, {
        diagnostics: dependencies.diagnostics,
        output: dependencies.output,
        json,
        ...(error.details.oneLine
          ? { left: { message: error.message, hint: error.hint } }
          : {}),
      });
    if (
      dependencies.signal?.aborted &&
      error instanceof RigError &&
      error.code === "CANCELLED"
    ) {
      // An action cancelled before it was submitted changed nothing. A read that ended before its answer is not an empty
      // answer, so it says so and exits as interrupted.
      if (!read) return 0;
      await reportFailure(interruptedRead(), {
        diagnostics: dependencies.diagnostics,
        output: dependencies.output,
        executable: "rig",
        json,
      });
      return 130;
    }
    await reportFailure(error, {
      diagnostics: dependencies.diagnostics,
      output: dependencies.output,
      executable: ["rig", ...commandPath(command, args)].join(" "),
      operationId,
      json,
    });
    return 1;
  }
}

/** A read cancelled before rigd's answer was printed, by Ctrl-C, SIGTERM or a reader that went away. */
function interruptedRead(): RigError {
  return new RigError(
    "CANCELLED",
    "The read was interrupted before rigd answered; nothing was printed.",
    "Run it again.",
  );
}
/** A failure before the command could run, such as an unusable Rig root, reported as the command's own failures are: a
 * read asked for --json prints one error document on stdout. Nothing is recorded, since the diagnostic log is kept under
 * that root. */
export async function reportStartupFailure(
  args: readonly string[],
  cwd: string,
  output: UserOutput,
  error: unknown,
): Promise<number> {
  const command = createRigCommand(cwd, output, async () => {});
  await reportFailure(error, {
    diagnostics: { record: async () => ({}) },
    output,
    executable: "rig",
    json: namesRead(command, args) && requestsJson(args),
  });
  return 1;
}
