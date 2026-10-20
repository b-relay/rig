import { RigError, cancelled } from "../domain/errors";
import { prepareInteractiveRequest } from "./interaction";
import {
  readActions,
  type MonitorResult,
  type RuntimeCommand,
} from "../daemon/protocol";
import type { CliDependencies, UserOutput } from "./types";
import { commandPath, createRigCommand, type ExecuteCommand } from "./commands";
import {
  jsonLines,
  object,
  readNotice,
  renderLogs,
  renderResult,
  renderStatus,
  shortenedLogs,
} from "./output";
import { waitStatus } from "./wait-notice";
import {
  liveDisplay,
  plainDisplay,
  type ProgressDisplay,
} from "./progress-display";
import { formatClock } from "./stop-display";
import { screenView } from "./live-region";
import { monitorLines } from "./monitor-output";
import type { MonitorWindowInput } from "./monitor-command";
import { logTimeWindow } from "./log-window";
import { terminalText } from "./terminal-text";
import { awaitRestore } from "./restore-wait";
import { serviceStopSchema, type ServiceStop } from "../daemon/protocol";
import { rigCommand, selectedTarget } from "../domain/rig-command";
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
    | "client"
    | "output"
    | "wait"
    | "signal"
    | "detach"
    | "now"
    | "liveOutput"
    | "terminalColumns"
  >,
  operationId: string,
): Promise<unknown> {
  const now = dependencies.now ?? (() => new Date());
  const display = dependencies.liveOutput
    ? liveDisplay(dependencies.output, dependencies.terminalColumns)
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
    display.note(
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
      { ...dependencies, detach },
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
    const detached = Boolean(left) || dependencies.detach?.aborted === true;
    // A second Ctrl-C while a stop is shown leaves it the way the first one would have.
    const stopping = display.stopping(now());
    display.abandon(now(), detached);
    if (left) throw left;
    if (dependencies.detach?.aborted && stopping.length)
      throw leftStopping(request, operationId, stopping);
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
  const down = rigCommand(
    "down",
    {
      project: request.project,
      target: selectedTarget(request, stopping[0]!.target),
    },
    "--kill",
  );
  return new RigError(
    "DETACHED",
    `Left ${names} stopping in the background (killing at ${formatClock(new Date(killAt), false)}).`,
    `Run ${terminalText(down)} to stop it now.`,
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
 * settles or is detached, and shows it: what it waits for while rigd holds it behind another Operation on the same
 * Target or Project, and the Services it waits on to stop while it runs. A first Ctrl-C does not end it, since the
 * command keeps waiting. Stops when rigd cannot say. */
async function reportProgress(
  dependencies: Pick<CliDependencies, "client" | "wait" | "detach">,
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
  const signal = dependencies.detach
    ? AbortSignal.any([dependencies.detach, done.signal])
    : done.signal;
  const pause = (ms: number) => dependencies.wait(ms, signal);
  await pause(NOTICE_AFTER_MS);
  while (!settled() && !signal.aborted) {
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
  // Set from the arguments once the grammar exists, then by the command that runs.
  let json = false;
  let exitCode = 0;
  const execute: ExecuteCommand = async (request, options = {}) => {
    json = options.json === true;
    // Assigned before preflight so a failure while gathering answers still names the Operation.
    operationId = dependencies.newOperationId();
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
    const watching =
      request.action === "monitor" &&
      options.follow === true &&
      dependencies.outputTerminal !== undefined;
    if (watching)
      await watchMonitor(correlated, result, options.window, dependencies);
    else
      await dependencies.output.write(
        json
          ? ["logs", "activity"].includes(request.action)
            ? jsonLines(request.action, result)
            : `${JSON.stringify(result)}\n`
          : status
            ? renderStatus(status, (dependencies.now ?? (() => new Date()))())
            : request.action === "monitor"
              ? `${monitorLines(result as MonitorResult, options.window ? { window: options.window } : {}).join("\n")}\n`
              : renderResult(request.action, result),
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
    if (request.action === "doctor" && object(result).ok === false)
      exitCode = 1;
    if (options.follow && request.action === "logs")
      await followLogs(correlated, result, dependencies, {
        json,
        full: options.full === true,
      });
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
/** Waits for the restore `started` began and resolves the reply with how it `ended`; fails RESTORE_FAILED, with where its
 * output is, when it did not succeed. A Ctrl-C while waiting leaves it running and says how to see its end. */
async function restoreOutcome(
  request: RuntimeCommand,
  started: unknown,
  operationId: string,
  dependencies: CliDependencies,
): Promise<unknown> {
  if (!json(started)) return started;
  const logs = terminalText(
    rigCommand("logs", {
      project: request.project,
      target: selectedTarget(
        request,
        String(started.target ?? request.target ?? "stable"),
      ),
      ...(request.job !== undefined ? { service: request.job } : {}),
    }),
  );
  if (!dependencies.signal?.aborted)
    dependencies.output.error(
      `Restoring ${request.job} from ${terminalText(String(started.backup ?? request.backup))}; its output is in ${logs}.\n`,
    );
  const ended = await awaitRestore(operationId, dependencies);
  // Interrupted: the wait ends, the restore goes on, and the exit (130) never reads as a restore that succeeded.
  if (!ended)
    throw new RigError(
      "DETACHED",
      "Stopped waiting; the restore goes on in the background.",
      `rig activity ${operationId} shows how it ends.`,
      { operationId, oneLine: true },
    );
  if (ended.outcome !== "succeeded")
    throw new RigError(
      "RESTORE_FAILED",
      `${ended.message ?? `${request.job}: the restore ${ended.outcome}`}.`,
      `Its output is in ${logs}.`,
      { operationId },
    );
  return { ...started, outcome: "restored", ended };
}
function json(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
/** `rig monitor` on a terminal: the table redrawn on the alternate screen after every sample, with the time it was
 * read, until cancellation; then the last table is left on the main screen. A read that fails ends the watch with that
 * failure, written below it. */
async function watchMonitor(
  request: RuntimeCommand,
  first: unknown,
  window: MonitorWindowInput | undefined,
  dependencies: CliDependencies,
): Promise<void> {
  const size = dependencies.outputTerminal!;
  const view = screenView((text) => dependencies.output.write(text), size);
  const clock = dependencies.now ?? (() => new Date());
  let result = first as MonitorResult;
  try {
    while (!dependencies.signal?.aborted) {
      view.draw([
        ...monitorLines(result, {
          columns: size().columns,
          ...(window ? { window } : {}),
        }),
        "",
        `Updated ${clock().toLocaleTimeString()} · Ctrl-C to stop`,
      ]);
      await dependencies.wait(result.sampledEvery * 1000, dependencies.signal);
      if (dependencies.signal?.aborted) return;
      // A duration is resolved again, so the window moves with the clock; an ISO time stays where it was.
      const next = await dependencies.client
        .command(
          window
            ? { ...request, window: logTimeWindow(window, clock()) }
            : request,
          dependencies.signal,
        )
        .catch(endsOnCancel(dependencies.signal));
      if (next === undefined) return;
      result = next as MonitorResult;
    }
  } finally {
    view.close();
  }
}
/** Entries fetched per follow poll: --lines sizes the first page only, so a busy Target is not throttled to it. */
const FOLLOW_BATCH_LINES = 1000;
/** Follow consumes opaque daemon cursors; duplicate text is never used as identity. Each page waits until its reader took
 * the one before, and an empty page still asks whether the reader is there. It ends on cancellation, which the entrypoint
 * also raises when the reader has gone away; that is how a stream with no end ends, so it is no failure. */
async function followLogs(
  request: RuntimeCommand,
  initial: unknown,
  dependencies: CliDependencies,
  print: { readonly json: boolean; readonly full: boolean },
): Promise<void> {
  let cursor = object(initial).cursor;
  while (!dependencies.signal?.aborted) {
    await dependencies.wait(250, dependencies.signal);
    if (dependencies.signal?.aborted) return;
    const result = await dependencies.client
      .command(
        {
          ...request,
          lines: FOLLOW_BATCH_LINES,
          ...(typeof cursor === "string" ? { after: cursor } : {}),
        },
        dependencies.signal,
      )
      .catch(endsOnCancel(dependencies.signal));
    if (result === undefined) return;
    const page = shortenedLogs(result, print.full);
    await dependencies.output.write(
      print.json ? jsonLines("logs", page) : renderLogs(page, false),
    );
    cursor = object(result).cursor;
  }
}
/** For a stream that runs until it is cancelled: a request the cancellation abandoned ends it (undefined); any other
 * failure is the stream's. */
function endsOnCancel(signal: AbortSignal | undefined) {
  return (error: unknown): undefined => {
    if (
      signal?.aborted &&
      error instanceof RigError &&
      error.code === "CANCELLED"
    )
      return undefined;
    throw error;
  };
}
/** The reads, by their command path; each takes --json: `proxy verify` and `backup list`, not `proxy reload` or
 * `backup restore`. */
const STRUCTURED_READS = [
  "list",
  "status",
  "doctor",
  "config",
  "activity",
  "logs",
  "monitor",
  "proxy",
  "proxy verify",
  "dns list",
  "backup list",
];
/** Whether the arguments name a read, from the grammar, even when argument validation fails before execution. The
 * command path is read from the words alone, so `rig proxy --json reload` is the reload it names. */
function namesRead(
  command: Parameters<typeof commandPath>[0],
  args: readonly string[],
): boolean {
  const words = beforeSeparator(args).filter((arg) => !arg.startsWith("-"));
  return STRUCTURED_READS.includes(commandPath(command, words).join(" "));
}
/** Error rendering follows the same scoped flag as the read's report. */
function requestsJson(args: readonly string[]): boolean {
  return beforeSeparator(args).includes("--json");
}
function beforeSeparator(args: readonly string[]): readonly string[] {
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
}
