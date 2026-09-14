import { RigError } from "../domain/errors";
import { prepareInteractiveRequest } from "./interaction";
import { readActions, type RuntimeCommand } from "../daemon/protocol";
import type { CliDependencies } from "./types";
import { createRigCommand, type ExecuteCommand } from "./commands";
import { renderResult, renderStatus, object, renderLogs } from "./output";
import {
  isHelp,
  recordDiagnostic,
  reportDetached,
  reportFailure,
} from "./failure";

/** Parse and render one invocation; the injected client owns runtime effects. */
/** How long a command may go unanswered before the user is told what rigd is doing instead. */
const NOTICE_AFTER_MS = 2000;
/** Sends the command and, when rigd has not answered in time, names the
 * operation it is running and how many wait ahead, so a hang has a cause.
 * A cancellation after submission is acknowledged but not honoured, since rigd
 * finishes the mutation either way; only detachment abandons the wait. */
async function awaitMutation(
  request: RuntimeCommand,
  dependencies: Pick<
    CliDependencies,
    "client" | "output" | "wait" | "signal" | "detach"
  >,
  operationId: string,
): Promise<unknown> {
  let settled = false;
  const acknowledge = () => {
    if (!settled)
      dependencies.output.error(
        `rigd is still running ${request.action} (operation ${operationId}); it finishes in the background. Press Ctrl-C again to detach.\n`,
      );
  };
  dependencies.signal?.addEventListener("abort", acknowledge, { once: true });
  const pending = dependencies.client
    .command(request, dependencies.detach)
    .finally(() => {
      settled = true;
    });
  try {
    await Promise.race([
      pending.catch(() => {}),
      dependencies.wait(NOTICE_AFTER_MS, dependencies.signal),
    ]);
    if (!settled && !dependencies.signal?.aborted)
      await reportQueuePosition(dependencies, operationId);
    return await Promise.race([pending, untilDetached(dependencies.detach)]);
  } catch (error) {
    if (dependencies.detach?.aborted)
      throw new RigError(
        "DETACHED",
        `Detached from operation ${operationId}.`,
        `Run rig activity ${operationId}.`,
        { operationId },
      );
    throw error;
  } finally {
    dependencies.signal?.removeEventListener("abort", acknowledge);
  }
}
/** Never settles unless the signal aborts; one command holds at most one such listener. */
function untilDetached(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}
/** Names the operation rigd is running and how many wait ahead of this one. */
async function reportQueuePosition(
  dependencies: Pick<CliDependencies, "client" | "output">,
  operationId: string,
): Promise<void> {
  const queue = object(
    await dependencies.client.command({ action: "queue" }).catch(() => ({})),
  );
  const running = object(queue.running);
  if (!running.operationId || running.operationId === operationId) return;
  const ahead = Number(queue.waiting ?? 0) - 1;
  const subject = [running.project, running.target, running.action]
    .filter((part) => typeof part === "string")
    .join(" ");
  dependencies.output.error(
    `Waiting: rigd is running ${subject} (operation ${String(running.operationId)}, started ${String(running.startedAt ?? "")})${
      ahead > 0 ? `; ${ahead} more ahead of this command` : ""
    }.\n`,
  );
}
export async function runRigCli(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  let operationId: string | undefined;
  let json = requestsStructuredOutput(args);
  let exitCode = 0;
  const execute: ExecuteCommand = async (request, options = {}) => {
    json = options.json === true;
    request = await prepareInteractiveRequest(request, dependencies, { json });
    operationId = dependencies.newOperationId();
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
    const status =
      request.action === "status"
        ? await dependencies.client.status(correlated)
        : undefined;
    const result =
      status ??
      (readActions.has(request.action)
        ? await dependencies.client.command(correlated, dependencies.signal)
        : await awaitMutation(correlated, dependencies, operationId));
    dependencies.output.write(
      json
        ? `${JSON.stringify(result)}\n`
        : status
          ? renderStatus(status)
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
    if (error instanceof RigError && error.code === "DETACHED" && operationId)
      return reportDetached(operationId, {
        diagnostics: dependencies.diagnostics,
        output: dependencies.output,
        json,
      });
    if (
      dependencies.signal?.aborted &&
      error instanceof RigError &&
      error.code === "CANCELLED"
    )
      return 0;
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

/** Entries fetched per follow poll: --lines sizes the first page only, so a busy Target is not throttled to it. */
const FOLLOW_BATCH_LINES = 1000;
/** Follow consumes opaque daemon cursors; duplicate text is never used as identity.
 * It ends on cancellation, which the entrypoint also raises when the terminal stops reading. */
async function followLogs(
  request: RuntimeCommand,
  initial: unknown,
  dependencies: CliDependencies,
): Promise<void> {
  let cursor = object(initial).cursor;
  while (!dependencies.signal?.aborted) {
    await dependencies.wait(250, dependencies.signal);
    if (dependencies.signal?.aborted) return;
    const result = await dependencies.client.command(
      {
        ...request,
        lines: FOLLOW_BATCH_LINES,
        ...(typeof cursor === "string" ? { after: cursor } : {}),
      },
      dependencies.signal,
    );
    dependencies.output.write(renderLogs(result, false));
    cursor = object(result).cursor;
  }
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
