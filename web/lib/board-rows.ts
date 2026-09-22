import type { Outcome } from "./outcome";
import { KIND_LABEL, targetWarnings } from "./present";
import { targetKey } from "./target";
import type {
  ComponentReport,
  ListResult,
  ProjectStatusReport,
  TargetReport,
} from "./types";

/** One registered Project and what rigd said about it; the status is absent while still on its way. */
export interface ProjectEntry {
  project: ListResult["projects"][number];
  status?: Outcome<ProjectStatusReport>;
}
/** One line of the board: a Target, or the Working copy a Project has not started yet. */
export interface TargetRow {
  /** Unique across the board: the Project name and the Target key. */
  id: string;
  project: string;
  projectHref: string;
  kind: TargetReport["kind"];
  kindLabel: string;
  name: string;
  /** The Target as rigd reported it; absent on the placeholder for a Working copy not started yet. */
  target?: TargetReport;
  state: string;
  branch?: string;
  commit?: string;
  route?: string;
  components: readonly ComponentReport[];
  /** The component names and ports as one string, so the filter box finds them. */
  componentsText: string;
  warnings: string[];
}
/** Something about a Project as a whole, shown above the table rather than on a row. */
export interface ProjectNotice {
  project: string;
  href: string;
  tone: "warn" | "bad";
  text: string;
}
/** The order Targets take within a Project when nothing is sorted: the Working copy, then Stable, then Previews. */
export const KIND_RANK: Record<TargetReport["kind"], number> = {
  local: 0,
  live: 1,
  preview: 2,
};
export const NOT_STARTED = "not started";
const projectHref = (name: string) => `/projects/${encodeURIComponent(name)}`;
const byKindThenName = (a: TargetReport, b: TargetReport) =>
  KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name);
/** Pure: the board's rows and notices from every Project's status, in board order. A Project
 * whose status failed or whose directory is gone contributes a notice and no rows; one whose
 * report lists no Working copy gets a placeholder row so it can be started from the table. */
export function boardRows(entries: readonly ProjectEntry[]): {
  rows: TargetRow[];
  notices: ProjectNotice[];
} {
  const rows: TargetRow[] = [];
  const notices: ProjectNotice[] = [];
  for (const { project, status } of entries) {
    const href = projectHref(project.name);
    if (project.missing) {
      notices.push({
        project: project.name,
        href: `${href}/settings`,
        tone: "bad",
        text: "The registered directory no longer exists. Repoint or forget it in its settings.",
      });
      continue;
    }
    if (!status) continue;
    if (!status.ok) {
      notices.push({
        project: project.name,
        href,
        tone: "bad",
        text: `${status.failure.code}: ${status.failure.message}`,
      });
      continue;
    }
    const report = status.value;
    for (const warning of report.warnings ?? [])
      notices.push({
        project: project.name,
        href,
        tone: "warn",
        text: warning,
      });
    if (!report.targets.some((target) => target.kind === "local"))
      rows.push(placeholderRow(project.name, href));
    for (const target of [...report.targets].sort(byKindThenName))
      rows.push(targetRow(project.name, href, target));
  }
  return { rows, notices };
}
function targetRow(
  project: string,
  href: string,
  target: TargetReport,
): TargetRow {
  return {
    id: `${project}/${targetKey(target)}`,
    project,
    projectHref: href,
    kind: target.kind,
    kindLabel: KIND_LABEL[target.kind],
    name: target.name,
    target,
    state: target.state,
    ...(target.branch ? { branch: target.branch } : {}),
    ...(target.commit ? { commit: target.commit } : {}),
    ...(target.route ? { route: target.route } : {}),
    components: target.components,
    componentsText: target.components
      .map((each) => (each.port ? `${each.name}:${each.port}` : each.name))
      .join(" "),
    warnings: targetWarnings(target),
  };
}
function placeholderRow(project: string, href: string): TargetRow {
  return {
    id: `${project}/local:`,
    project,
    projectHref: href,
    kind: "local",
    kindLabel: KIND_LABEL.local,
    name: NOT_STARTED,
    state: NOT_STARTED,
    components: [],
    componentsText: "",
    warnings: [],
  };
}
