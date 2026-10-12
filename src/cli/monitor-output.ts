import type { MonitorResult } from "../daemon/protocol";
import { formatBytes } from "../domain/bytes";
import { formatCpu as percent } from "../domain/usage-sample";
import { fitted, padded } from "./live-region";
import { isDuration } from "./log-window";
import { terminalText } from "./terminal-text";

type ReportedSeries = MonitorResult["series"][number];
type Stats = NonNullable<ReportedSeries["summary"]["cpu"]>;

const HEADINGS = ["CPU", "median", "peak", "Memory", "median", "peak"];

/** The narrowest the name column is cut to, however narrow the terminal. */
const NAME_FLOOR = 12;
const GAP = "  ";

/** Pure: the window as the user gave it, in words: `the last 1h`, `since 2026-10-12T02:00:00Z`, or `from 2d ago to
 * 1d ago`. No input reads as the last hour, as rigd reads it. */
export function windowWords(input: {
  readonly since?: string;
  readonly until?: string;
}): string {
  const since = input.since ?? "1h";
  const time = (value: string) =>
    isDuration(value) ? `${value} ago` : terminalText(value);
  if (input.until === undefined)
    return isDuration(since)
      ? `the last ${since}`
      : `since ${terminalText(since)}`;
  return `from ${time(since)} to ${time(input.until)}`;
}

/** Pure: a `monitor` reply as the lines of a table: one row per series, CPU and memory now, then the median and peak over
 * the window. For a Project: its total over every Target, then each Target's total with its Services and Jobs indented
 * below it. For the Host: the Host's total, Rig itself, then each Project. A value with no sample reads `–`. `window`
 * is the window as the user gave it, for the heading; with `columns`, long names are cut so the numbers still fit. */
export function monitorLines(
  result: MonitorResult,
  options: {
    readonly window?: { readonly since?: string; readonly until?: string };
    readonly columns?: number;
  } = {},
): string[] {
  const columns = options.columns;
  const words = windowWords(options.window ?? {});
  const rows =
    result.project === undefined ? hostRows(result) : projectRows(result);
  const heading = `${result.project === undefined ? "This Host" : terminalText(result.project)} · ${words} · sampled every ${result.sampledEvery} s`;
  if (rows.length === 0)
    return [
      heading,
      `No CPU or memory was sampled ${words.startsWith("the last") ? "in " : ""}${words}: nothing ran, or rigd was not sampling then.`,
    ];
  const values = rows.map(([, series]) => cells(series));
  const widths = HEADINGS.map((heading, column) =>
    Math.max(heading.length, ...values.map((row) => row[column]!.length)),
  );
  const numbers = widths.reduce((sum, width) => sum + width + GAP.length, 0);
  const longest = Math.max(...rows.map(([name]) => Bun.stringWidth(name)));
  const nameWidth =
    columns === undefined
      ? longest
      : Math.min(longest, Math.max(NAME_FLOOR, columns - numbers - 1));
  const line = (name: string, cellsOf: readonly string[]) =>
    [
      padded(
        Bun.stringWidth(name) > nameWidth ? fitted(name, nameWidth) : name,
        nameWidth,
        "end",
      ),
      ...cellsOf.map((cell, column) => padded(cell, widths[column]!, "start")),
    ]
      .join(GAP)
      .trimEnd();
  return [
    heading,
    "",
    line("", HEADINGS),
    ...rows.map(([name], index) => line(name, values[index]!)),
  ];
}

function projectRows(result: MonitorResult): [string, ReportedSeries][] {
  const total = result.series.filter((each) => each.series.scope === "project");
  const byTarget = new Map<string, ReportedSeries[]>();
  for (const each of result.series)
    if (each.series.scope === "component") {
      const key = each.series.targetId ?? "";
      const parts = byTarget.get(key);
      if (parts) parts.push(each);
      else byTarget.set(key, [each]);
    }
  // Each Target's total, then its own Services and Jobs indented under it, in the reply's order.
  return [
    ...total.map((each): [string, ReportedSeries] => ["all Targets", each]),
    ...result.series
      .filter((each) => each.series.scope === "target")
      .flatMap((target): [string, ReportedSeries][] => [
        [terminalText(target.series.target ?? "?"), target],
        ...(byTarget.get(target.series.targetId ?? "") ?? []).map(
          (part): [string, ReportedSeries] => [
            `  ${terminalText(part.series.component ?? "?")}${part.series.componentKind === "job" ? " (job)" : ""}`,
            part,
          ],
        ),
      ]),
  ];
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
