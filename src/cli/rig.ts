import { RigError, cancelled } from "../domain/errors";
import { prepareInteractiveRequest } from "./interaction";
import { readActions, type RuntimeCommand } from "../daemon/protocol";
import type { CliDependencies } from "./types";
import { commandPath, createRigCommand, type ExecuteCommand } from "./commands";
import { renderResult, renderStatus, object, renderLogs } from "./output";
import { waitStatus } from "./wait-notice";
import {
  liveDisplay,
  plainDisplay,
  type ProgressDisplay,
} from "./progress-display";
import { formatClock } from "./stop-display";
import { serviceStopSchema, type ServiceStop } from "../daemon/protocol";
import { PREVIEW_SELECTOR } from "../config/schema";
import { z } from "zod";
import {
  isHelp,
  recordDiagnostic,
  reportDetached,
  reportFailure,
} from "./failure";

/** Parse and render one invocation; the injected client owns runtime effects. */
/** How long a command may go unanswered before the user is told what rigd is doing instead. */
const NOTICE_AFTER_MS = 2000;
/** How often a waiting command asks rigd again where it stands, and redraws a countdown on a terminal. */
const PROGRESS_TICK_MS = 1000;
/** Sends the command and, when rigd has not answered in time, shows what it waits for and the Services it waits on to
 * stop, so a long wait has a cause and a deadline. A cancellation after submission is acknowledged but not honoured, since
 * rigd finishes the mutation either way; only detachment abandons the wait. While a stop is shown, the first Ctrl-C
 * detaches at once and says how to end the stop now. */
async function awaitMutation(
  request: RuntimeCommand,
  dependencies: Pick<
    CliDependencies,
    "client" | "output" | "wait" | "signal" | "detach" | "now" | "liveOutput"
  >,
  operationId: string,
): Promise<unknown> {
  const now = dependencies.now ?? (() => new Date());
  const display = dependencies.liveOutput
    ? liveDisplay(dependencies.output)
    : plainDisplay(dependencies.output);
  // Leaving a stop to rigd: detaches like a second Ctrl-C, with the stop named.
  const leave = new AbortController();
  let left: RigError | undefined;
  let settled = false;
  const interrupted = () => {
    if (settled) return;
    const stopping = display.stopping(now());
    if (stopping.length) {
      left = leftStopping(request, operationId, stopping);
      leave.abort(left);
      return;
    }
    dependencies.output.error(
      `rigd is still running ${request.action} (operation ${operationId}); it finishes in the background. Press Ctrl-C again to detach.\n`,
    );
  };
  dependencies.signal?.addEventListener("abort", interrupted, { once: true });
  const detach = dependencies.detach
    ? AbortSignal.any([dependencies.detach, leave.signal])
    : leave.signal;
  const pending = dependencies.client.command(request, detach).finally(() => {
    settled = true;
  });
  try {
    void reportProgress(
      dependencies,
      display,
      now,
      operationId,
      pending,
      () => settled,
    ).catch(() => {});
    const result = await Promise.race([pending, untilDetached(detach)]);
    display.finish(stopsOf(result), now());
    return result;
  } catch (error) {
    if (left) throw left;
    if (dependencies.detach?.aborted)
      throw new RigError(
        "DETACHED",
        `Detached from operation ${operationId}.`,
        `Run rig activity ${operationId}.`,
        { operationId },
      );
    throw error;
  } finally {
    dependencies.signal?.removeEventListener("abort", interrupted);
  }
}
/** The detachment a Ctrl-C during a shown stop makes: `Left <service> stopping in the background (killing at 04:31). Run
 * rig down <target> --kill to stop it now.` */
function leftStopping(
  request: RuntimeCommand,
  operationId: string,
  stopping: readonly ServiceStop[],
): RigError {
  const services = stopping.map((stop) => stop.service);
  const names =
    services.length > 1
      ? `${services.slice(0, -1).join(", ")} and ${services.at(-1)}`
      : services[0]!;
  const killAt = Math.min(...stopping.map((stop) => Date.parse(stop.killAt)));
  const target = stopping[0]!.target;
  const selector =
    request.target === PREVIEW_SELECTOR
      ? `preview --deployment ${target}`
      : target;
  const project = request.project ? ` --project ${request.project}` : "";
  return new RigError(
    "DETACHED",
    `Left ${names} stopping in the background (killing at ${formatClock(new Date(killAt), false)}).`,
    `Run rig down ${selector}${project} --kill to stop it now.`,
    { operationId, oneLine: true },
  );
}
/** The stops a mutation's result reports, when it has any. */
function stopsOf(result: unknown): ServiceStop[] | undefined {
  const parsed = z
    .object({ stops: z.array(serviceStopSchema) })
    .safeParse(result);
  return parsed.success ? parsed.data.stops : undefined;
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
/** Once the command has gone NOTICE_AFTER_MS without an answer, asks rigd every PROGRESS_TICK_MS where it stands until it
 * settles or is cancelled, and shows it: what it waits for while rigd holds it behind another Operation on the same
 * Target or Project, and the Services it waits on to stop while it runs. Stops when rigd cannot say. */
async function reportProgress(
  dependencies: Pick<CliDependencies, "client" | "wait" | "signal">,
  display: ProgressDisplay,
  now: () => Date,
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
  await pause(NOTICE_AFTER_MS);
  while (!settled() && !dependencies.signal?.aborted) {
    const reply = await dependencies.client
      .command({ action: "queue", operation: operationId })
      .catch(() => undefined);
    const status = waitStatus(reply, now());
    if (status === undefined || settled()) return;
    display.show(status, now());
    await pause(PROGRESS_TICK_MS);
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
          ? renderStatus(status, (dependencies.now ?? (() => new Date()))())
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
        ...(error.details.oneLine
          ? { left: { message: error.message, hint: error.hint } }
          : {}),
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
