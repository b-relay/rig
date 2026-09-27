import { RigError, cancelled } from "../domain/errors";
import { prepareInteractiveRequest } from "./interaction";
import { readActions, type RuntimeCommand } from "../daemon/protocol";
import type { CliDependencies } from "./types";
import { commandPath, createRigCommand, type ExecuteCommand } from "./commands";
import { renderResult, renderStatus, object, renderLogs } from "./output";
import { waitStatus } from "./wait-notice";
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
    void reportWaiting(dependencies, operationId, pending, () => settled).catch(
      () => {},
    );
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
/** How often a waiting command asks rigd again what it is waiting for. */
const WAIT_POLL_MS = 2000;
/** Once the command has gone NOTICE_AFTER_MS without an answer, asks rigd every WAIT_POLL_MS where it
 * stands until it settles or is cancelled. Whenever rigd holds it behind another Operation on the same
 * Target or Project, prints what it waits for on stderr: one plain line when a wait starts and one
 * whenever what it waits for changes, never a cursor movement. Stops when rigd cannot say. */
async function reportWaiting(
  dependencies: Pick<CliDependencies, "client" | "output" | "wait" | "signal">,
  operationId: string,
  pending: Promise<unknown>,
  settled: () => boolean,
): Promise<void> {
  // A pause ends when the command settles, and its timer is released then, so nothing keeps rig alive after its answer.
  const done = new AbortController();
  void pending.then(
    () => done.abort(),
    () => done.abort(),
  );
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, done.signal])
    : done.signal;
  const pause = (ms: number) => dependencies.wait(ms, signal);
  let shown: string | undefined;
  await pause(NOTICE_AFTER_MS);
  while (!settled() && !dependencies.signal?.aborted) {
    const status = waitStatus(
      await dependencies.client
        .command({ action: "queue", operation: operationId })
        .catch(() => undefined),
    );
    if (status === undefined || settled()) return;
    // A command running now shows nothing of its own yet; a later wait is announced again.
    if (status.state === "running") shown = undefined;
    else if (status.notice !== shown) {
      dependencies.output.error(`${status.notice}\n`);
      shown = status.notice;
    }
    await pause(WAIT_POLL_MS);
  }
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
    // Assigned before preflight so a failure while gathering answers still names the Operation.
    operationId = dependencies.newOperationId();
    request = await prepareInteractiveRequest(request, dependencies, { json });
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
    dependencies.recipes,
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
      executable: ["rig", ...commandPath(command, args)].join(" "),
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
    ["status", "up", "down", "restart", "deploy"].includes(args[0] ?? "")
  );
}
