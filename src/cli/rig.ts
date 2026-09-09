import { RigError } from "../domain/errors";
import { prepareInteractiveRequest } from "./interaction";
import type { RuntimeCommand } from "../daemon/protocol";
import type { CliDependencies } from "./types";
import { createRigCommand, type ExecuteCommand } from "./commands";
import { renderResult, object, renderLogs } from "./output";
import { isHelp, recordDiagnostic, reportFailure } from "./failure";

/** Parse and render one invocation; the injected client owns runtime effects. */
export async function runRigCli(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  let operationId: string | undefined;
  let json = requestsStructuredOutput(args);
  let exitCode = 0;
  const execute: ExecuteCommand = async (request, options = {}) => {
    json = options.json === true;
    request = await prepareInteractiveRequest(request, dependencies);
    operationId = dependencies.newOperationId();
    json = options.json === true;
    const correlated = { ...request, operationId };
    await recordDiagnostic(dependencies.diagnostics, {
      event: "command.started",
      operationId,
      action: request.action,
      project: request.project,
      target: request.target,
    });
    if (dependencies.signal?.aborted)
      throw new RigError(
        "CANCELLED",
        "The operation was cancelled.",
        "No runtime change was requested.",
      );
    const result = await dependencies.client.command(correlated);
    dependencies.output.write(
      json
        ? `${JSON.stringify(result)}\n`
        : renderResult(request.action, result),
    );
    const evidence = await recordDiagnostic(dependencies.diagnostics, {
      event: "command.completed",
      operationId,
      action: request.action,
      project: request.project,
      target: request.target,
    });
    if (evidence.error) dependencies.output.error(`${evidence.error}\n`);
    if (request.action === "doctor" && object(result).ok === false)
      exitCode = 1;
    if (options.follow) await followLogs(correlated, result, dependencies);
  };
  const command = createRigCommand(
    dependencies.cwd,
    dependencies.output,
    execute,
  );
  try {
    await command.parseAsync(args.length ? [...args] : ["--help"], {
      from: "user",
    });
    return exitCode;
  } catch (error) {
    if (isHelp(error)) return 0;
    if (dependencies.signal?.aborted) return 0;
    await reportFailure(error, {
      diagnostics: dependencies.diagnostics,
      output: dependencies.output,
      executable: "rig",
      operationId,
      json,
    });
    return 1;
  }
}

/** Follow consumes opaque daemon cursors; duplicate text is never used as identity. */
async function followLogs(
  request: RuntimeCommand,
  initial: unknown,
  dependencies: CliDependencies,
): Promise<void> {
  let cursor = object(initial).cursor;
  while (!dependencies.signal?.aborted) {
    await (dependencies.wait ?? wait)(250, dependencies.signal);
    if (dependencies.signal?.aborted) return;
    const result = await dependencies.client.command({
      ...request,
      ...(typeof cursor === "string" ? { after: cursor } : {}),
    });
    dependencies.output.write(renderLogs(result, false));
    cursor = object(result).cursor;
  }
}
async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Error rendering follows the same scoped flag even when argument validation fails before execution. */
function requestsStructuredOutput(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  return (
    options.includes("--json") &&
    (["status", "up", "down", "restart"].includes(args[0] ?? "") ||
      (args[0] === "deploy" && ["live", "preview"].includes(args[1] ?? "")))
  );
}
