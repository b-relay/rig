import { RigError, lastOutputLine } from "../domain/errors";
import type { OperatorAlert, OperatorAlerts } from "../domain/operator-alerts";
import type { CommandRunner } from "./contracts";

/** The AppleScript that shows one notification. The texts arrive as arguments, never as script source, so nothing in an
 * alert can change what runs. */
const SCRIPT = [
  "on run argv",
  "display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)",
  "end run",
];
/** Notification Center shows a few lines; longer text is cut with an ellipsis rather than left to the system. */
const SUBTITLE_LIMIT = 120;
const BODY_LIMIT = 240;
const TIMEOUT_MS = 10_000;

/** The macOS user notification channel: `osascript` posts a notification titled "Rig" with the alert's title as the
 * subtitle and its summary as the text. It works from rigd's LaunchAgent, which runs in the user's GUI session; macOS
 * files the notification under Script Editor, whose notifications the user allows once in System Settings. */
export function createMacosNotifications(deps: {
  run: CommandRunner;
  /** osascript; replaceable in tests. */
  executable?: string;
}): OperatorAlerts {
  const channel = "macOS notification";
  return {
    channel,
    async send(alert: OperatorAlert) {
      const result = await deps.run({
        command: [
          deps.executable ?? "/usr/bin/osascript",
          ...SCRIPT.flatMap((line) => ["-e", line]),
          "--",
          "Rig",
          shortened(alert.title, SUBTITLE_LIMIT),
          shortened(alert.summary, BODY_LIMIT),
        ],
        timeoutMs: TIMEOUT_MS,
      });
      if (result.exitCode === 0) return;
      const said = lastOutputLine(result.stderr);
      throw new RigError(
        "ALERT_DELIVERY",
        result.timedOut
          ? `osascript did not post the ${channel} within ${TIMEOUT_MS / 1000} s.`
          : `osascript could not post the ${channel} (exit ${result.exitCode}${said ? `: ${said}` : ""}).`,
        "Check that rigd runs in your logged-in session (rigd status) and that notifications from Script Editor are allowed in System Settings > Notifications.",
        { exitCode: result.exitCode, ...(said ? { stderr: said } : {}) },
      );
    },
  };
}

function shortened(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
