import type { Outcome } from "./outcome";
import { targetWarnings, toneOf, type Tone } from "./present";
import type { ListResult, ProjectStatusReport, TargetReport } from "./types";

/** One registered Project and what rigd said about it; the status is absent while still on its way. */
export interface ProjectEntry {
  project: ListResult["projects"][number];
  status?: Outcome<ProjectStatusReport>;
}
/** The order Targets take within a Project: working, then stable, then Previews. */
export const KIND_RANK: Record<TargetReport["kind"], number> = {
  working: 0,
  stable: 1,
  preview: 2,
};

/** How bad a tone is, so a group of Targets can be summed up by its worst member. */
const SEVERITY: Record<Tone, number> = {
  bad: 4,
  warn: 3,
  busy: 2,
  good: 1,
  idle: 0,
};
/** Pure: the most urgent tone among `states`; idle when there are none. */
export function worstTone(states: readonly string[]): Tone {
  return states
    .map(toneOf)
    .reduce<Tone>(
      (worst, tone) => (SEVERITY[tone] > SEVERITY[worst] ? tone : worst),
      "idle",
    );
}
/** Pure: whether a Target needs someone to look at it: a failing state, or a warning such as an unpublished route. */
export const needsAttention = (target: TargetReport): boolean =>
  ["bad", "warn"].includes(toneOf(target.state)) ||
  targetWarnings(target).length > 0;
/** The counts the overview's header line shows. */
export interface OverviewSummary {
  projects: number;
  targets: number;
  /** Targets whose processes run (healthy or running). */
  live: number;
  /** Targets that need attention, and Projects whose status could not be read. */
  attention: number;
}
/** Pure: the overview's counts from every Project's status. A Project whose status failed, or whose
 * directory is gone, counts as one thing needing attention. */
export function overviewSummary(
  entries: readonly ProjectEntry[],
): OverviewSummary {
  let targets = 0,
    live = 0,
    attention = 0;
  for (const { project, status } of entries) {
    if (project.missing || (status && !status.ok)) {
      attention++;
      continue;
    }
    for (const target of status?.value.targets ?? []) {
      targets++;
      if (toneOf(target.state) === "good") live++;
      if (needsAttention(target)) attention++;
    }
  }
  return { projects: entries.length, targets, live, attention };
}
/** Pure: a Project's Targets in the order every page lists them: working, stable, then Previews by name. */
export function orderedTargets(
  targets: readonly TargetReport[],
): TargetReport[] {
  return [...targets].sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name),
  );
}
