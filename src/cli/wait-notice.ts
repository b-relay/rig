import { queueResultSchema } from "../daemon/protocol";

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

/** Where a command's own Operation stands, from rigd's `queue` reply naming it: waiting, with the line
 * to print, or running. Undefined when rigd does not know it or the reply is not understood. */
export function waitStatus(
  reply: unknown,
): { state: "waiting"; notice: string } | { state: "running" } | undefined {
  const parsed = queueResultSchema.safeParse(reply);
  const position = parsed.success ? parsed.data.operation : undefined;
  if (position?.state === "running") return { state: "running" };
  const notice = waitNotice(reply);
  return notice === undefined ? undefined : { state: "waiting", notice };
}
/** The line a command prints while it waits for another Operation, from rigd's `queue` reply for
 * that command's own Operation; undefined when the Operation is not waiting or the reply is not
 * understood. Plain text without cursor movement, so it reads the same in a pipe or a log. */
export function waitNotice(reply: unknown): string | undefined {
  const parsed = queueResultSchema.safeParse(reply);
  const position = parsed.success ? parsed.data.operation : undefined;
  if (position?.state !== "waiting") return undefined;
  const [first, ...others] = position.waitingOn;
  const more = others.length + position.ahead;
  const behind = more > 0 ? `; ${more} more ahead of this command` : "";
  if (!first)
    return `Waiting: ${position.ahead} operation${position.ahead === 1 ? "" : "s"} ahead of this command.`;
  const subject =
    [first.project, first.target].filter(Boolean).join(" ") || "rigd";
  const doing = PHASE_WORDS[first.phase] ?? `is running ${first.action}`;
  return `Waiting: ${subject} ${doing} (operation ${first.operationId}, started ${first.startedAt})${behind}.`;
}
