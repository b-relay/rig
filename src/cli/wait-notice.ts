import { queueResultSchema, type ServiceStop } from "../daemon/protocol";
import { formatClock, formatDuration } from "./stop-display";

/** How each phase reads after the Target's name. */
const PHASE_WORDS: Record<string, string> = {
  starting: "is starting",
  stopping: "is stopping",
  restarting: "is restarting",
  deploying: "is deploying",
  destroying: "is being destroyed",
  registering: "is being registered",
  renaming: "is being renamed",
  repointing: "is being repointed",
  forgetting: "is being forgotten",
  "editing config": "is having its config edited",
  reconciling: "is being reconciled after rigd started",
  supervising: "is being checked for automatic restarts",
  "preparing to uninstall": "is preparing to uninstall",
};
/** How a phase reads when rigd itself, not a Project or Target, is what the command waits for. */
const HOST_WORDS: Record<string, string> = {
  reconciling: "is checking every Target after it started",
};

/** Where a command's own Operation stands, from rigd's `queue` reply naming it.
 * - `waiting`: the line to show, what it waits for (`subject`, which changes when the wait does), and when the Service it
 *   waits on is killed, if it waits on a stop.
 * - `running`: the Services it has asked to stop so far.
 * Undefined when rigd does not know it or the reply is not understood. */
export type WaitStatus =
  | { state: "waiting"; notice: string; subject: string; killAt?: string }
  | {
      state: "running";
      project?: string;
      target?: string;
      stops: ServiceStop[];
    };
export function waitStatus(reply: unknown, now: Date): WaitStatus | undefined {
  const parsed = queueResultSchema.safeParse(reply);
  const position = parsed.success ? parsed.data.operation : undefined;
  if (position?.state === "running")
    return {
      state: "running",
      ...(position.project ? { project: position.project } : {}),
      ...(position.target ? { target: position.target } : {}),
      stops: position.stops ?? [],
    };
  if (position?.state !== "waiting") return undefined;
  const [first, ...others] = position.waitingOn;
  const more = others.length + position.ahead;
  const behind = more > 0 ? `; ${more} more ahead of this command` : "";
  if (!first)
    return {
      state: "waiting",
      subject: `ahead:${position.ahead}`,
      notice: `Waiting: ${position.ahead} operation${position.ahead === 1 ? "" : "s"} ahead of this command`,
    };
  const subject =
    [first.project, first.target].filter(Boolean).join(" ") || "rigd";
  const doing =
    (subject === "rigd" ? HOST_WORDS[first.phase] : undefined) ??
    PHASE_WORDS[first.phase] ??
    `is running ${first.action}`;
  const stopping =
    first.phase === "stopping"
      ? first.stops?.find((stop) => stop.state === "stopping")
      : undefined;
  if (stopping)
    return {
      state: "waiting",
      subject: `${first.operationId}|stopping|${stopping.target}|${stopping.service}`,
      killAt: stopping.killAt,
      notice: `Waiting: ${subject} ${doing} (${stopping.service}, ${killingAt(stopping.killAt, now)})${behind}`,
    };
  return {
    state: "waiting",
    subject: `${first.operationId}|${first.phase}`,
    notice: `Waiting: ${subject} ${doing} (operation ${first.operationId}, started ${formatClock(new Date(first.startedAt), true)})${behind}`,
  };
}
/** `killing in 18m at 04:31`, or `killing now` once it is due. */
function killingAt(killAt: string, now: Date): string {
  const left = Date.parse(killAt) - now.getTime();
  return left <= 0
    ? "killing now"
    : `killing in ${formatDuration(left, "minutes")} at ${formatClock(new Date(killAt), false)}`;
}
/** The line a command prints while it waits for another Operation, from rigd's `queue` reply for that command's own
 * Operation; undefined when the Operation is not waiting or the reply is not understood. */
export function waitNotice(reply: unknown, now: Date): string | undefined {
  const status = waitStatus(reply, now);
  return status?.state === "waiting" ? status.notice : undefined;
}
