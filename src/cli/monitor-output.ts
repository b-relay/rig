import type { MonitorResult } from "../daemon/protocol";
import { formatBytes } from "../domain/bytes";
import { terminalText } from "./terminal-text";

type ReportedSeries = MonitorResult["series"][number];
type Stats = NonNullable<ReportedSeries["summary"]["cpu"]>;

const HEADINGS = ["CPU", "median", "peak", "Memory", "median", "peak"];
const RANGE_WORDS: Record<MonitorResult["range"], string> = {
  "1h": "the last hour",
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
};

/** Pure: a `monitor` reply as the lines of a table: one row per series, CPU and memory now, then the median and peak over
 * the range. For a Project: its total over every Target, then each Target's total with its Services and Jobs indented
 * below it. For the Host: the Host's total, Rig itself, then each Project. A value with no sample reads `–`. */
export function monitorLines(result: MonitorResult): string[] {
  const rows =
    result.project === undefined ? hostRows(result) : projectRows(result);
  const heading = `${result.project === undefined ? "This Host" : terminalText(result.project)} · ${RANGE_WORDS[result.range]} · sampled every ${result.sampledEvery} s`;
  if (rows.length === 0)
    return [
      heading,
      `No CPU or memory was sampled in ${RANGE_WORDS[result.range]}: nothing ran, or rigd only just started sampling.`,
    ];
  const table = [
    ["", ...HEADINGS],
    ...rows.map(([name, series]) => [name, ...cells(series)]),
  ];
  const widths = table[0]!.map((_, column) =>
    Math.max(...table.map((row) => row[column]!.length)),
  );
  return [
    heading,
    "",
    ...table.map((row) =>
      row
        .map((cell, column) =>
          column === 0
            ? cell.padEnd(widths[0]!)
            : cell.padStart(widths[column]!),
        )
        .join("  ")
        .trimEnd(),
    ),
  ];
}

function projectRows(result: MonitorResult): [string, ReportedSeries][] {
  const rows: [string, ReportedSeries][] = [];
  for (const each of result.series) {
    const { scope, target, component, componentKind } = each.series;
    if (scope === "project") rows.push(["all Targets", each]);
    if (scope === "target") rows.push([terminalText(target ?? "?"), each]);
    if (scope === "component")
      rows.push([
        `  ${terminalText(component ?? "?")}${componentKind === "job" ? " (job)" : ""}`,
        each,
      ]);
  }
  // A Target's Components follow it: the reply orders Targets before Components, so each is moved under its own.
  const ordered: [string, ReportedSeries][] = rows.filter(
    ([, each]) => each.series.scope === "project",
  );
  for (const [name, each] of rows)
    if (each.series.scope === "target") {
      ordered.push([name, each]);
      ordered.push(
        ...rows.filter(
          ([, part]) =>
            part.series.scope === "component" &&
            part.series.targetId === each.series.targetId,
        ),
      );
    }
  return ordered;
}

function hostRows(result: MonitorResult): [string, ReportedSeries][] {
  return result.series.map((each) => [
    each.series.scope === "host"
      ? "Host"
      : each.series.scope === "rig"
        ? "Rig itself"
        : terminalText(each.series.project ?? "?"),
    each,
  ]);
}

function cells(series: ReportedSeries): string[] {
  const { cpu, memory } = series.summary;
  return [
    series.now ? percent(series.now.cpuPercent) : "–",
    stat(cpu, "median", percent),
    stat(cpu, "high", percent),
    series.now ? formatBytes(series.now.memoryBytes) : "–",
    stat(memory, "median", formatBytes),
    stat(memory, "high", formatBytes),
  ];
}

function stat(
  stats: Stats | undefined,
  field: "median" | "high",
  format: (value: number) => string,
): string {
  return stats ? format(stats[field]) : "–";
}

/** Pure: a CPU share as Activity Monitor shows it: one decimal below 10%, whole percents from there. */
export function percent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}
