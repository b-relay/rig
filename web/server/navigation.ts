import type { Outcome } from "../lib/outcome";
import { pulseStamp, type PulseReadings } from "../lib/pulse";
import type { ProjectStatusReport } from "../lib/types";
import { pagePulse } from "./pulse";
import { projectStatusRead } from "./status";

/** How long a Project's status may stand in the sidebar for a fresh read: the live refresh's own interval. */
export const NAVIGATION_KEPT_MS = 15_000;

/** A status kept for the sidebar: the pulse stamp it was read under, and when that pulse answered. */
interface Kept {
  readonly stamp: string;
  readonly at: number;
  readonly report: ProjectStatusReport;
}
const kept = new Map<string, Kept>();
/** Moves on whenever what is kept is dropped, so a read that began before then is not kept after. */
let generation = 0;

/** Pure: the stamp a pulse vouches for reads under, when it can: every reading answered and no Operation runs, so what
 * rigd records next changes the stamp. `undefined` otherwise, and nothing is kept or reused under it. */
export function vouchingStamp(readings: PulseReadings): string | undefined {
  if (!readings.health.ok || !readings.queue.ok || !readings.activity.ok)
    return undefined;
  const pulse = pulseStamp(readings);
  return pulse.busy ? undefined : pulse.stamp;
}

/** Each Project's status as the sidebar shows it, for `projects` (the listed Projects whose directory exists). A status read
 * in the last `NAVIGATION_KEPT_MS` stands in for a fresh one while this page's pulse has the stamp it was read under and
 * vouches for it; otherwise the Project is read afresh, sharing the page's own read of it. A read is kept only when it
 * began after the pulse answered, so it holds everything that stamp covers; a failure is never kept, and Projects no
 * longer listed are dropped. */
export async function navigationStatuses(
  projects: readonly string[],
): Promise<Map<string, Outcome<ProjectStatusReport>>> {
  const since = generation;
  const pulse = await pagePulse();
  const stamp = vouchingStamp(pulse.readings);
  const now = performance.now();
  for (const name of kept.keys())
    if (!projects.includes(name)) kept.delete(name);
  const entries = await Promise.all(
    projects.map(async (project) => {
      const before = kept.get(project);
      if (
        stamp !== undefined &&
        before?.stamp === stamp &&
        now - before.at < NAVIGATION_KEPT_MS
      )
        return [project, { ok: true, value: before.report }] as const;
      const read = projectStatusRead(project);
      const outcome = await read.outcome;
      if (
        outcome.ok &&
        stamp !== undefined &&
        read.began >= pulse.settledAt &&
        generation === since
      )
        kept.set(project, {
          stamp,
          at: pulse.settledAt,
          report: outcome.value,
        });
      else if (!outcome.ok) kept.delete(project);
      return [project, outcome] as const;
    }),
  );
  return new Map(entries);
}

/** Drops every kept status: a command or config change from this site may change what the sidebar shows before rigd
 * records it. */
export function forgetNavigation(): void {
  generation += 1;
  kept.clear();
}
