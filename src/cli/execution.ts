import { cancelled } from "../domain/errors";
import { prepareInteractiveRequest } from "./interaction";
import { readActions, type RuntimeCommand } from "../daemon/protocol";
import type { CliDependencies } from "./types";
import type { ExecuteCommand } from "./commands";
import { object, readNotice, shortenedLogs } from "./output";
import { awaitMutation } from "./mutation-wait";
import { restoreOutcome } from "./restore-wait";
import { watchMonitor } from "./monitor-watch";
import { followLogs } from "./log-follow";
import { resultOutput } from "./result-output";
import { recordDiagnostic } from "./failure";

type CommandOptions = NonNullable<Parameters<ExecuteCommand>[1]>;

/** Runs one command the grammar parsed as Operation `operationId`: gathers its answers, sends it to rigd, waits for a
 * mutation, and renders the answer. Answers the exit code: 1 when doctor found a problem, otherwise 0. */
export async function executeCommand(
  request: RuntimeCommand,
  options: CommandOptions,
  operationId: string,
  dependencies: CliDependencies,
): Promise<number> {
  const json = options.json === true;
  request = await prepareInteractiveRequest(request, dependencies, {
    yes: options.yes === true,
  });
  const correlated = { ...request, operationId };
  await recordDiagnostic(dependencies.diagnostics, {
    event: "command.started",
    operationId,
    action: request.action,
    project: request.project,
    target: request.target,
  });
  if (dependencies.signal?.aborted) throw cancelled();
  const status =
    request.action === "status"
      ? await dependencies.client.status(correlated, dependencies.signal)
      : undefined;
  let result =
    status ??
    (readActions.has(request.action)
      ? await dependencies.client.command(correlated, dependencies.signal)
      : await awaitMutation(correlated, dependencies, operationId));
  // A restore answers once its run started; rig waits for it to end, so the command says how the restore went.
  if (request.action === "restore")
    result = await restoreOutcome(request, result, operationId, dependencies);
  if (request.action === "logs")
    result = shortenedLogs(result, options.full === true);
  const terminal = dependencies.outputTerminal;
  if (request.action === "monitor" && options.follow === true && terminal)
    await watchMonitor(correlated, result, options.window, {
      ...dependencies,
      outputTerminal: terminal,
    });
  else
    await dependencies.output.write(
      resultOutput(request.action, result, {
        json,
        ...(status ? { status } : {}),
        ...(options.window ? { window: options.window } : {}),
        now: dependencies.now ?? (() => new Date()),
      }),
    );
  // What a read left out goes to stderr, so a file stdout is redirected to holds only the records.
  const notice = readNotice(request.action, result);
  if (notice) dependencies.output.error(`${notice}\n`);
  const evidence = await recordDiagnostic(dependencies.diagnostics, {
    event: "command.completed",
    operationId,
    action: request.action,
    project: request.project,
    target: request.target,
  });
  if (evidence.error) dependencies.output.error(`${evidence.error}\n`);
  const exitCode =
    request.action === "doctor" && object(result).ok === false ? 1 : 0;
  if (options.follow && request.action === "logs")
    await followLogs(correlated, result, dependencies, {
      json,
      full: options.full === true,
    });
  return exitCode;
}
