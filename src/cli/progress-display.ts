import type { ServiceStop } from "../daemon/protocol";
import type { UserOutput } from "./types";
import type { WaitStatus } from "./wait-notice";
import {
  PLAIN_LAST_CALL_MS,
  PLAIN_REPEAT_MS,
  formatClock,
  plainStopLines,
  type PlainStopState,
  stopBoard,
  visibleStopping,
} from "./stop-display";

/** Shows a running command's progress on stderr: what it waits for, and the Services it waits on to stop. */
export interface ProgressDisplay {
  /** Shows where the command stands at `now`. */
  show(status: WaitStatus, now: Date): void;
  /** The command succeeded: shows how its stops ended, from its result when that has them. */
  finish(stops: readonly ServiceStop[] | undefined, now: Date): void;
  /** The command failed, or the user detached, while Services it showed were still stopping: they are shown as left to
   * rigd. A detached command says so itself, so without a terminal nothing more is printed then. */
  abandon(now: Date, detached: boolean): void;
  /** Writes `text` on stderr outside the progress, which carries on below it. */
  note(text: string): void;
  /** The Services it has shown as still stopping, for the Ctrl-C message. */
  stopping(now: Date): ServiceStop[];
}

/** On a terminal: one region redrawn in place, holding either the line of what the command waits for or the stop board.
 * Each line is cut to the terminal's `columns`, so a redraw always moves up exactly the rows it drew. */
export function liveDisplay(
  output: Pick<UserOutput, "error">,
  columns = 80,
): ProgressDisplay {
  let drawn: string[] = [];
  let project: string | undefined;
  let stops: readonly ServiceStop[] = [];
  const fit = (line: string) =>
    line.length < columns
      ? line
      : `${line.slice(0, Math.max(columns - 2, 1))}…`;
  const draw = (lines: readonly string[]) => {
    const next = lines.map(fit);
    if (next.join("\n") === drawn.join("\n")) return;
    // Up to the region's first row, then clear to the end of the screen before writing it again.
    const erase = drawn.length ? `\x1b[${drawn.length}A\r\x1b[J` : "";
    output.error(`${erase}${next.map((line) => `${line}\n`).join("")}`);
    drawn = next;
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
    abandon(now) {
      const board = stopBoard(project, stops, now, true);
      if (board.length) draw(board);
    },
    note(text) {
      output.error(text);
      drawn = [];
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
    abandon(now, detached) {
      if (detached) return;
      write(
        visibleStopping(stops, now).map(
          (stop) =>
            `${stop.service} still stopping in rigd (killing at ${formatClock(new Date(stop.killAt), true)})`,
        ),
      );
    },
    note: (text) => output.error(text),
    stopping: (now) => visibleStopping(stops, now),
  };
}
