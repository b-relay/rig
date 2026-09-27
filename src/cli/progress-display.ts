import type { ServiceStop } from "../daemon/protocol";
import type { UserOutput } from "./types";
import type { WaitStatus } from "./wait-notice";
import {
  PLAIN_LAST_CALL_MS,
  PLAIN_REPEAT_MS,
  plainStopLines,
  type PlainStopState,
  stopBoard,
  visibleStopping,
} from "./stop-display";

/** Shows a running command's progress on stderr: what it waits for, and the Services it waits on to stop. */
export interface ProgressDisplay {
  /** Shows where the command stands at `now`. */
  show(status: WaitStatus, now: Date): void;
  /** The command settled: shows how its stops ended, from its result when that has them. */
  finish(stops: readonly ServiceStop[] | undefined, now: Date): void;
  /** The Services it has shown as still stopping, for the Ctrl-C message. */
  stopping(now: Date): ServiceStop[];
}

/** On a terminal: one region redrawn in place, holding either the line of what the command waits for or the stop board. */
export function liveDisplay(
  output: Pick<UserOutput, "error">,
): ProgressDisplay {
  let drawn = 0;
  let project: string | undefined;
  let stops: readonly ServiceStop[] = [];
  const draw = (lines: readonly string[]) => {
    // Up to the region's first line, then clear to the end of the screen before writing it again.
    const erase = drawn ? `\x1b[${drawn}A\r\x1b[J` : "";
    if (!erase && !lines.length) return;
    output.error(`${erase}${lines.map((line) => `${line}\n`).join("")}`);
    drawn = lines.length;
  };
  return {
    show(status, now) {
      if (status.state === "waiting") return draw([status.notice]);
      project = status.project;
      stops = status.stops;
      // A command that runs now no longer waits; its stops show once one has waited a while.
      draw(stopBoard(project, stops, now));
    },
    finish(ended, now) {
      if (ended) stops = ended;
      const board = stopBoard(project, stops, now);
      if (board.length) draw(board);
    },
    stopping: (now) => visibleStopping(stops, now),
  };
}

/** Without a terminal (a pipe, CI, an agent): plain appended lines, never a cursor movement. A wait is announced when it
 * starts or changes, again every five minutes, and once a minute before its Service is killed; a stop as
 * `plainStopLines` says. */
export function plainDisplay(
  output: Pick<UserOutput, "error">,
): ProgressDisplay {
  const printed = new Map<string, PlainStopState>();
  let stops: readonly ServiceStop[] = [];
  let waiting: { subject: string; at: number; left?: number } | undefined;
  const write = (lines: readonly string[]) => {
    if (lines.length) output.error(lines.map((line) => `${line}\n`).join(""));
  };
  return {
    show(status, now) {
      if (status.state === "running") {
        waiting = undefined;
        stops = status.stops;
        return write(plainStopLines(printed, stops, now));
      }
      const left =
        status.killAt === undefined
          ? undefined
          : Date.parse(status.killAt) - now.getTime();
      const due =
        waiting?.subject !== status.subject ||
        now.getTime() - waiting.at >= PLAIN_REPEAT_MS ||
        (left !== undefined &&
          left > 0 &&
          left <= PLAIN_LAST_CALL_MS &&
          (waiting.left ?? 0) > PLAIN_LAST_CALL_MS);
      if (!due) return;
      write([status.notice]);
      waiting = {
        subject: status.subject,
        at: now.getTime(),
        ...(left === undefined ? {} : { left }),
      };
    },
    finish(ended, now) {
      if (ended) stops = ended;
      write(plainStopLines(printed, stops, now));
    },
    stopping: (now) => visibleStopping(stops, now),
  };
}
