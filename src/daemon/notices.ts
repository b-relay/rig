import type { DiagnosticLog } from "../diagnostics/types";
import type {
  RuntimeDependencies,
  RuntimeNotice,
  WorkReport,
} from "../runtime/contracts";
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
    "Until supervising what the message names succeeds, a Service of it that exits is not recorded as Activity, its route not withheld and its restart policy not applied; rigd tries again every second.",
  hint: "Inspect rigd status, the runtime state file under the Rig root, and rig doctor's proxy checks.",
};
export const HEALTH_MONITOR: NoticeChannel = {
  name: "health",
  consequence:
    "Ongoing health checks (healthcheck) of the Services named are not run, or their result is missing from Activity or the Target log, until they succeed; rigd tries again every second.",
  hint: "Check that the runtime state file and the Target logs under the Rig root are writable, and read rig activity.",
};
export const JOB_SCHEDULER: NoticeChannel = {
  name: "jobs",
  consequence:
    "The scheduled starts, recorded ends, timeouts or clean-ups named did not happen until they succeed; rigd tries again every second.",
  hint: "Inspect the runtime state file under the Rig root, and rig activity.",
};
export const USAGE_SAMPLER: NoticeChannel = {
  name: "usage",
  consequence:
    "The last CPU and memory sample, or the write or prune of their history, failed, so Monitor's history may have a gap; rigd keeps sampling and tries the write again within seconds.",
  hint: "Check that the monitor directory under the Rig root is writable; on a Mac where rigd samples with ps, also check that /bin/ps runs. The notice clears once a sample succeeds and any failed write or prune has succeeded since.",
};
/** Bounded in-memory evidence: one entry per channel, a count, and the latest message. A channel's notice stays while any of
 * its work is failing: each failure is noted under the work it is about (`work`, `pass` when absent), and a clear with a
 * `work` clears only that work's, so one success never hides another's failure. Never writes anywhere, so a failing sink
 * cannot recurse. */
export interface NoticeBoard {
  note(channel: NoticeChannel, message: string, work?: string): void;
  /** Clears the failure of `work`, or with none every failure of the channel. */
  clear(channel: NoticeChannel, work?: string): void;
  list(): RuntimeNotice[];
}
const MESSAGE_LIMIT = 200;
/** The work a monitor's pass is, when a failure names no other. */
const PASS = "pass";
export function createNoticeBoard(now: () => string): NoticeBoard {
  const notices = new Map<
    string,
    {
      notice: RuntimeNotice;
      /** The latest message of each work failing now, oldest first. */
      failing: Map<string, string>;
    }
  >();
  return {
    note(channel, message, work = PASS) {
      const at = now();
      const text =
        message.length > MESSAGE_LIMIT
          ? `${message.slice(0, MESSAGE_LIMIT - 1)}…`
          : message;
      const current = notices.get(channel.name);
      const failing = current?.failing ?? new Map<string, string>();
      failing.delete(work);
      failing.set(work, text);
      notices.set(channel.name, {
        failing,
        notice: {
          channel: channel.name,
          count: (current?.notice.count ?? 0) + 1,
          firstAt: current?.notice.firstAt ?? at,
          lastAt: at,
          message: text,
          consequence: channel.consequence,
          hint: channel.hint,
        },
      });
    },
    clear(channel, work) {
      const current = notices.get(channel.name);
      if (work !== undefined) current?.failing.delete(work);
      if (!current || work === undefined || !current.failing.size) {
        notices.delete(channel.name);
        return;
      }
      // What is still failing is what the notice says.
      current.notice.message = [...current.failing.values()].at(-1)!;
    },
    list: () => [...notices.values()].map((entry) => entry.notice),
  };
}
/** The report background work of `channel` gives: a failure is noted under its work, and that work's success clears it. */
export function workReport(
  notices: Pick<NoticeBoard, "note" | "clear">,
  channel: NoticeChannel,
): WorkReport {
  return {
    failed(work, about, error) {
      notices.note(channel, `${about} failed: ${describeFailure(error)}`, work);
    },
    succeeded(work) {
      notices.clear(channel, work);
    },
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
 * (`nextRetryAt`, Unix milliseconds). A failed pass is noted on `channel` (the failure monitor's when absent), and a later
 * pass that succeeds clears that failure only: what the pass's own work reports (see `workReport`) stays until that work
 * succeeds. Returns the stop, which starts no further pass and resolves once the pass in flight, if any, settled. */
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
          options.notices.clear(channel, PASS);
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
