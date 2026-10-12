import { cache } from "react";
import { attempt, type Outcome } from "../lib/outcome";
import type { ProjectStatusReport } from "../lib/types";
import { projectHref } from "../lib/target";
import {
  bytes,
  chartReport,
  componentsOf,
  percent,
  presetWindow,
  type ChartReport,
  type UsageRange,
} from "../lib/usage";
import type { ChipTarget } from "../components/target-chip";
import { read } from "./daemon";
import { projectStatus } from "./status";

/** A Project's Monitor tab as both its page and the Target chip in its header see it: the report, the Targets the
 * chip offers, and the one shown. */
export interface ProjectMonitorView {
  readonly usage: Outcome<ChartReport>;
  readonly targets: readonly ChipTarget[];
  /** The Target shown, by name, or `all`. */
  readonly target: string;
  /** The Target's Services and Jobs, or with `all` every Target: what gets a card before it is sampled. */
  readonly inventory: readonly {
    readonly name: string;
    readonly kind?: string;
  }[];
  /** What all Targets together use now, worded. */
  readonly allDetail?: string;
  hrefOf(target: string): string;
}

/** A Project's Monitor tab over `range`, read once per request however many parts of the page ask. `wanted` is the
 * `?target=` asked for: a Target the Project has or had in the range, or `all`; otherwise stable when it has history,
 * else the first Target. */
export const projectMonitor = cache(
  async (
    project: string,
    range: UsageRange,
    wanted: string | undefined,
  ): Promise<ProjectMonitorView> => {
    const [monitored, status] = await Promise.all([
      attempt(
        read({
          action: "monitor",
          project,
          window: presetWindow(range, Date.now()),
        }),
      ),
      projectStatus(project),
    ]);
    const whole = monitored.ok
      ? chartReport(monitored.value, range)
      : undefined;
    const hrefOf = (next: string) =>
      `${projectHref(project)}/monitor?${new URLSearchParams({ target: next, range })}`;
    const current = status.ok ? status.value.targets : [];
    const targets = chipTargets(whole, current, hrefOf);
    const target =
      wanted === "all" || targets.some((each) => each.name === wanted)
        ? wanted!
        : (targets.find((each) => each.name === "stable" && each.detail)
            ?.name ??
          targets[0]?.name ??
          "all");
    const total = whole?.series.find((each) => each.series.scope === "project");
    return {
      usage: monitored.ok
        ? { ok: true, value: componentsOf(whole!, target) }
        : monitored,
      targets,
      target,
      inventory: inventoryOf(current, target),
      ...(total?.now && {
        allDetail: `${percent(total.now.cpuPercent)} · ${bytes(total.now.memoryBytes)}`,
      }),
      hrefOf,
    };
  },
);

/** Pure: the Targets the chip offers: every Target the Project has now, in status order, and any whose history the
 * range still holds (a destroyed Preview), each with what it uses now. */
function chipTargets(
  report: ChartReport | undefined,
  current: ProjectStatusReport["targets"],
  hrefOf: (target: string) => string,
): ChipTarget[] {
  const now = new Map(
    (report?.series ?? [])
      .filter((each) => each.series.scope === "target")
      .map((each) => [each.series.target!, each.now]),
  );
  const names = [
    ...current.map((target) => target.name),
    ...[...now.keys()].filter(
      (name) => !current.some((target) => target.name === name),
    ),
  ];
  return names.map((name) => {
    const usage = now.get(name);
    return {
      name,
      state:
        current.find((target) => target.name === name)?.state ?? "destroyed",
      href: hrefOf(name),
      ...(usage && {
        detail: `${percent(usage.cpuPercent)} · ${bytes(usage.memoryBytes)}`,
      }),
    };
  });
}

/** Pure: what gets a card before it is sampled: every Target, or the Target's Services (its managed Components, the
 * ones rigd runs) and its Jobs. */
function inventoryOf(
  current: ProjectStatusReport["targets"],
  target: string,
): { name: string; kind?: string }[] {
  if (target === "all") return current.map((each) => ({ name: each.name }));
  const found = current.find((each) => each.name === target);
  return [
    ...(found?.components ?? [])
      .filter((component) => component.kind === "managed")
      .map((component) => ({ name: component.name, kind: "service" })),
    ...(found?.jobs ?? []).map((job) => ({ name: job.name, kind: "job" })),
  ];
}
