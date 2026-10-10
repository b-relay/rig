import type { LogTarget } from "../components/log-viewer";
import { logComponentChoices } from "../lib/logs";
import { attempt } from "../lib/outcome";
import { orderedTargets } from "../lib/overview";
import { targetSelector } from "../lib/target";
import type { LogsResult, TargetReport } from "../lib/types";
import { read } from "./daemon";

/** Pure: the Targets a log viewer may read, in page order, each with the names its lines are recorded under. */
export function logTargets(targets: readonly TargetReport[]): LogTarget[] {
  return orderedTargets(targets).map(({ name, kind, components }) => ({
    name,
    kind,
    components: logComponentChoices(components),
  }));
}
/** The last 200 lines of one Target for the first paint; nothing when rigd refused, which the viewer's own read then reports. */
export async function firstLogPage(
  project: string,
  target: Pick<TargetReport, "name" | "kind"> | undefined,
): Promise<LogsResult | undefined> {
  if (!target) return undefined;
  const page = await attempt(
    read({ action: "logs", project, ...targetSelector(target), lines: 200 }),
  );
  return page.ok ? (page.value as LogsResult) : undefined;
}
