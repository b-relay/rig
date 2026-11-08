import type { MonitorResult } from "../daemon/protocol";
import type { ProjectStatusReport } from "../domain/project-status";
import { jsonLines, renderResult, renderStatus } from "./output";
import { monitorLines } from "./monitor-output";
import type { MonitorWindowInput } from "./monitor-command";

/** How a command's answer is shown: as asked by --json, the status report when it is one, the window `rig monitor` was
 * given, and the clock a status is read against. */
export interface ResultView {
  readonly json: boolean;
  readonly status?: ProjectStatusReport;
  readonly window?: MonitorWindowInput;
  readonly now: () => Date;
}

/** Pure but for `view.now`, read only for a status shown as text: the stdout text of `action`'s answer `result`. With
 * --json, a logs or activity read prints JSON Lines, one record per line, and any other read one JSON document; without
 * it, the status table, the Monitor table, or the action's own view. */
export function resultOutput(
  action: string,
  result: unknown,
  view: ResultView,
): string {
  if (view.json)
    return ["logs", "activity"].includes(action)
      ? jsonLines(action, result)
      : `${JSON.stringify(result)}\n`;
  if (view.status) return renderStatus(view.status, view.now());
  if (action === "monitor")
    return `${monitorLines(result as MonitorResult, view.window ? { window: view.window } : {}).join("\n")}\n`;
  return renderResult(action, result);
}
