import type { DiagnosticLog } from "../diagnostics/types";
import type { RuntimeDependencies, RuntimeNotice } from "../runtime/contracts";
import { RigError } from "../domain/errors";
/** A background channel whose failure the daemon reports through doctor instead of dropping. */
export interface NoticeChannel {
  name: string;
  /** What the failure means for the user while it persists. */
  consequence: string;
  hint: string;
}
export const DIAGNOSTIC_SINK: NoticeChannel = {
  name: "diagnostics",
  consequence: "Operation outcomes were not affected.",
  hint: "Check that logs/rigd under the Rig root is writable, then run doctor again; the count resets when rigd restarts.",
};
export const FAILURE_MONITOR: NoticeChannel = {
  name: "monitor",
  consequence:
    "Component crashes are not recorded as Activity until a pass succeeds; the monitor retries every 5 s.",
  hint: "Inspect rigd status and the runtime state file under the Rig root.",
};
export const HEALTH_MONITOR: NoticeChannel = {
  name: "health",
  consequence:
    "Ongoing health checks (healthcheck) are not run, so no Service is found unhealthy or restarted for it, until a pass succeeds; rigd tries again every second.",
  hint: "Inspect the runtime state file under the Rig root, and rig activity.",
};
export const JOB_SCHEDULER: NoticeChannel = {
  name: "jobs",
  consequence:
    "Scheduled jobs are not started, and ended runs are not recorded, until a pass succeeds; rigd tries again every second.",
  hint: "Inspect the runtime state file under the Rig root, and rig activity.",
};
/** Bounded in-memory evidence: one entry per channel, a count, and the latest message. Never writes anywhere, so a failing sink cannot recurse. */
export interface NoticeBoard {
  note(channel: NoticeChannel, message: string): void;
  clear(channel: NoticeChannel): void;
  list(): RuntimeNotice[];
}
const MESSAGE_LIMIT = 200;
export function createNoticeBoard(now: () => string): NoticeBoard {
  const notices = new Map<string, RuntimeNotice>();
  return {
    note(channel, message) {
      const at = now();
      const text =
        message.length > MESSAGE_LIMIT
          ? `${message.slice(0, MESSAGE_LIMIT - 1)}…`
          : message;
      const current = notices.get(channel.name);
      notices.set(channel.name, {
        channel: channel.name,
        count: (current?.count ?? 0) + 1,
        firstAt: current?.firstAt ?? at,
        lastAt: at,
        message: text,
        consequence: channel.consequence,
        hint: channel.hint,
      });
    },
    clear(channel) {
      notices.delete(channel.name);
    },
    list: () => [...notices.values()],
  };
}
/** Records one operation outcome; a sink failure, returned or thrown, becomes a notice and never reaches the operation. */
export function recordingDiagnostic(
  log: Pick<DiagnosticLog, "record">,
  notices: Pick<NoticeBoard, "note">,
): RuntimeDependencies["diagnostic"] {
  return async (event) => {
    let failure: string | undefined;
    try {
      failure = (
        await log.record({
          event: "operation.completed",
          ...event,
          code: event.errorCode,
        })
      ).error;
    } catch (error) {
      failure = describeFailure(error);
    }
    if (failure !== undefined)
      notices.note(
        DIAGNOSTIC_SINK,
        `Diagnostic evidence was not recorded: ${failure}`,
      );
  };
}
/** Runs one pass at a time on a fixed interval, and once more when a pass names an earlier time something is due
 * (`nextRetryAt`, Unix milliseconds). A failed pass is noted on `channel` (the failure monitor's when absent), a later
 * success clears it. Returns the stop, which starts no further pass and resolves once the pass in flight, if any, settled. */
export function startFailureMonitor(options: {
  intervalMs: number;
  run(): Promise<{ nextRetryAt?: number } | void>;
  notices: Pick<NoticeBoard, "note" | "clear">;
  channel?: NoticeChannel;
}): () => Promise<void> {
  const channel = options.channel ?? FAILURE_MONITOR;
  let running = false,
    stopped = false;
  let due: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const pass = () => {
    if (running || stopped) return;
    running = true;
    inFlight = options
      .run()
      .then(
        (result) => {
          options.notices.clear(channel);
          if (stopped || result?.nextRetryAt === undefined) return;
          clearTimeout(due);
          due = setTimeout(pass, Math.max(0, result.nextRetryAt - Date.now()));
        },
        (error) =>
          options.notices.note(
            channel,
            `The ${channel === FAILURE_MONITOR ? "failure" : channel.name} monitor's last pass failed: ${describeFailure(error)}`,
          ),
      )
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(pass, options.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(due);
    return inFlight;
  };
}
/** Metadata only: a code and message, never entry contents. */
function describeFailure(error: unknown): string {
  return error instanceof RigError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}
