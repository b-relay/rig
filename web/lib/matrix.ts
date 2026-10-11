import { healthOf, projectHealth, type Health } from "./health";
import { orderedTargets, type ProjectEntry } from "./overview";
import { ago, toneOf } from "./present";
import { projectHref } from "./target";
import type { ComponentReport, JobReport, TargetReport } from "./types";

/* The overview's matrix, one per Project: its Targets across the top, its Services, stores, Tools
 * and jobs down the side, and a tile for each row on each Target. Everything here is pure, so the
 * page only lays it out. */

/** What a row is to the person reading: something rig runs, keeps data in, installs, or runs on a
 * schedule. */
export type RowKind = "service" | "store" | "tool" | "job";
const COMPONENT_KIND: Record<ComponentReport["kind"], RowKind> = {
  managed: "service",
  persistent: "store",
  installed: "tool",
};
export interface MatrixRow {
  /** Unique within the matrix: jobs and components may share a name. */
  key: string;
  name: string;
  kind: RowKind;
}
/** Something about the Project as a whole, said beneath its matrix. */
export interface MatrixNotice {
  tone: "warn" | "bad";
  text: string;
  href: string;
}
export interface ProjectMatrix {
  project: string;
  href: string;
  /** As healthy as its least healthy Target; gray with nothing running. */
  health: Health;
  /** The stable Target's hostname, whose favicon is the Project's icon. */
  stableRoute?: string;
  /** Working, stable, then Previews by name. */
  columns: TargetReport[];
  /** Every component any Target has, in the order they first appear, then every job. */
  rows: MatrixRow[];
  notices: MatrixNotice[];
  /** Set when there is nothing to lay out: the directory is gone or rigd could not report. */
  problem?: MatrixNotice;
}

/** Pure: one matrix per registered Project, in list order. A Project whose status is still on its
 * way has no columns and no problem. */
export function projectMatrices(
  entries: readonly ProjectEntry[],
): ProjectMatrix[] {
  return entries.map(projectMatrix);
}
/** Pure: the matrix of one Project. */
export function projectMatrix({
  project,
  status,
}: ProjectEntry): ProjectMatrix {
  const href = projectHref(project.name);
  const base = {
    project: project.name,
    href,
    columns: [] as TargetReport[],
    rows: [] as MatrixRow[],
    notices: [] as MatrixNotice[],
  };
  if (project.missing)
    return {
      ...base,
      health: "red",
      problem: {
        tone: "bad",
        href: `${href}/settings`,
        text: "The registered directory no longer exists. Repoint or forget it in its settings.",
      },
    };
  if (!status) return { ...base, health: "gray" };
  if (!status.ok)
    return {
      ...base,
      health: "red",
      problem: {
        tone: "bad",
        href,
        text: [
          `${status.failure.code}: ${status.failure.message}`,
          status.failure.hint,
        ]
          .filter(Boolean)
          .join(" "),
      },
    };
  const columns = orderedTargets(status.value.targets);
  const stableRoute = columns.find((target) => target.kind === "stable")?.route;
  return {
    ...base,
    health: projectHealth(columns.map((target) => target.state)),
    ...(stableRoute ? { stableRoute } : {}),
    columns,
    rows: matrixRows(columns),
    notices: (status.value.warnings ?? []).map((text) => ({
      tone: "warn" as const,
      href,
      text,
    })),
  };
}
/** Pure: every component any Target has, in the order they first appear across the columns, then
 * every job the same way. */
export function matrixRows(columns: readonly TargetReport[]): MatrixRow[] {
  const components = new Map<string, RowKind>();
  const jobs = new Set<string>();
  for (const target of columns) {
    for (const component of target.components)
      if (!components.has(component.name))
        components.set(component.name, COMPONENT_KIND[component.kind]);
    for (const job of target.jobs ?? []) jobs.add(job.name);
  }
  return [
    ...[...components].map(([name, kind]) => ({
      key: `component:${name}`,
      name,
      kind,
    })),
    ...[...jobs].map((name) => ({
      key: `job:${name}`,
      name,
      kind: "job" as const,
    })),
  ];
}
/** One tile of the matrix: a word, how healthy it reads, and a short detail on the right. A row the
 * Target does not have is `absent`. */
export type Tile =
  | { absent: true }
  | {
      absent?: false;
      word: string;
      health: Health;
      /** The state is in motion (starting, stopping, a job running); its dot pulses. */
      busy: boolean;
      /** A port (`:4000`) or, for a job, when it runs next. */
      detail?: string;
      /** Everything else, for the tooltip. */
      title: string;
    };
/** Pure: the tile for `row` on `target`, with `now` the instant job times are measured from. */
export function matrixTile(
  target: TargetReport,
  row: MatrixRow,
  now: number,
): Tile {
  if (row.kind === "job") {
    const job = target.jobs?.find((each) => each.name === row.name);
    return job ? jobTile(job, now) : { absent: true };
  }
  const component = target.components.find((each) => each.name === row.name);
  if (!component) return { absent: true };
  return {
    word: component.state,
    health: healthOf(component.state),
    busy: toneOf(component.state) === "busy",
    ...(component.port !== undefined ? { detail: `:${component.port}` } : {}),
    title: [
      component.state,
      component.pid ? `pid ${component.pid}` : undefined,
      component.reason,
    ]
      .filter(Boolean)
      .join(", "),
  };
}
/** Pure: a job as a tile: running, or how its last run ended (or that it never ran), with its
 * next run on the right. */
export function jobTile(job: JobReport, now: number): Tile {
  const word =
    job.state === "running"
      ? "running"
      : job.removed
        ? "removed"
        : (job.last?.outcome ?? (job.last ? "unknown" : "never run"));
  const health: Health =
    job.state === "running" ? "orange" : job.last ? healthOf(word) : "gray";
  return {
    word,
    health,
    busy: job.state === "running",
    ...(job.nextRunAt ? { detail: until(job.nextRunAt, now) } : {}),
    title: [
      job.schedule
        ? `${job.schedule}${job.timeZone ? ` ${job.timeZone}` : ""}`
        : undefined,
      job.last
        ? `last ${ago(job.last.startedAt, now)}: ${job.last.summary}`
        : undefined,
      job.nextRunAt ? undefined : (job.reason ?? "not scheduled"),
    ]
      .filter(Boolean)
      .join(". "),
  };
}
/** Pure: how far off a coming instant is, in the coarsest unit that still says something. */
export function until(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds < 60) return "in <1 min";
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)} h`;
  return `in ${Math.round(seconds / 86400)} d`;
}
