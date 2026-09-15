import type { ProjectStatusReport } from "../domain/project-status";
import { terminalText } from "./terminal-text";
/** Human presenters consume the same domain report returned by structured commands. */
export function renderResult(action: string, value: unknown): string {
  const report = object(value);
  if (action === "list") return renderProjects(report);
  if (action === "doctor") return renderDoctor(report);
  if (action === "config")
    return `${word(report.project)}\n${word(report.path)}\n\n${JSON.stringify(report.config, null, 2)}\n`;
  if (action === "logs") return renderLogs(report, true);
  if (action === "activity") return renderActivity(report);
  if (action === "daemon-status")
    return `Installed  ${report.installed ? "yes" : "no"}\nRunning    ${report.running ? "yes" : "no"}\nReachable  ${report.reachable ? "yes" : "no"}\n${
      report.version ? `Version    ${word(report.version)}\n` : ""
    }${
      Array.isArray(report.warnings)
        ? report.warnings.map((value) => `Warning: ${word(value)}\n`).join("")
        : ""
    }`;
  const subject =
    [word(report.project), word(report.target)].filter(Boolean).join(" ") ||
    "rigd";
  const outcome =
    word(report.outcome) ||
    { "daemon-install": "installed", "daemon-uninstall": "uninstalled" }[
      action
    ];
  if (!outcome) return `${subject}: operation returned no final outcome.\n`;
  const path =
    action === "init" && report.path ? `\nConfig: ${word(report.path)}` : "";
  const revision =
    action === "deploy" && report.branch && report.commit
      ? ` ${word(report.branch)}@${word(report.commit).slice(0, 7)}${
          report.previousCommit && report.previousCommit !== report.commit
            ? ` (was ${word(report.previousCommit).slice(0, 7)})`
            : ""
        }`
      : "";
  const warnings = Array.isArray(report.warnings)
    ? report.warnings.map((value) => `Warning: ${word(value)}\n`).join("")
    : "";
  const replaced = object(report.replaced);
  const upgrade =
    action === "daemon-install" && report.replaced
      ? ` (replaced rigd ${word(replaced.version) || "of an older version"}, pid ${Number(replaced.pid)})`
      : "";
  const retired = rows(report.retired)
    .map(
      (entry) =>
        `${word(report.project)} ${word(entry.target)} retired${entry.branch ? ` ${word(entry.branch)}` : ""} (${word(entry.reason)})\n`,
    )
    .join("");
  return `${retired}${subject} ${outcome}${upgrade}${revision}${path}\n${warnings}`;
}
function renderProjects(report: Record<string, unknown>): string {
  const projects = rows(report.projects);
  return projects.length
    ? `${projects
        .map(
          (project) =>
            `${word(project.name)}  ${Number(project.targetCount ?? 0)} Targets  ${word(project.repoPath)}${
              project.missing === true
                ? `  (directory missing: rig repoint or rig forget ${word(project.name)})`
                : ""
            }`,
        )
        .join("\n")}\n`
    : "No Projects registered.\n";
}
export function renderStatus(report: ProjectStatusReport): string {
  const lines = [word(report.project)];
  const failures: string[] = [];
  for (const target of report.targets) {
    lines.push(
      "",
      [word(target.name), word(target.state), deployedFrom(target)]
        .filter(Boolean)
        .join("  "),
    );
    const unpublished = target.routePublished === false ? "unpublished" : "";
    if (target.route && !target.components.some((component) => component.route))
      lines.push(
        `  Route  ${[word(target.route), unpublished].filter(Boolean).join("  ")}`,
      );
    for (const component of target.components) {
      const port = component.port !== undefined ? `:${component.port}` : "";
      const route = component.route
        ? [word(component.route), unpublished].filter(Boolean).join("  ")
        : "";
      lines.push(
        `  ${[word(component.name), word(component.state), port, route].filter(Boolean).join("  ")}`,
      );
      if (["failed", "unhealthy", "missing"].includes(component.state))
        failures.push(
          `${word(target.name)} ${word(component.name)}: ${word(component.reason) || word(component.state)}`,
        );
      if (
        component.reason &&
        !["failed", "unhealthy", "missing"].includes(component.state)
      )
        lines.push(`    ${word(component.reason)}`);
    }
  }
  if (!report.targets.length) lines.push("", "No Targets configured.");
  if (failures.length)
    lines.push("", "Failures", ...failures.map((failure) => `  ${failure}`));
  else lines.push("", "No failures");
  if (
    report.targets.some(
      (target) =>
        target.state === "unknown" ||
        target.components.some((component) => component.state === "unknown"),
    )
  )
    lines.push("Some observations are unknown.");
  for (const warning of report.warnings ?? [])
    lines.push(`Warning: ${word(warning)}`);
  return `${lines.join("\n")}\n`;
}
/** A deployed Target shows the Branch and Commit it serves; the Working copy shows neither. */
function deployedFrom(
  target: Pick<
    ProjectStatusReport["targets"][number],
    "kind" | "branch" | "commit"
  >,
): string {
  const commit = word(target.commit).slice(0, 7);
  const branch = word(target.branch);
  if (branch && commit) return `${branch}@${commit}`;
  if (branch || commit) return branch || commit;
  return target.kind === "local" ? "working copy" : "";
}
function renderDoctor(report: Record<string, unknown>): string {
  const failures = rows(report.checks).filter((check) => check.ok !== true);
  const note = word(report.note);
  if (!failures.length && report.ok === true)
    return `${word(report.project) ? `Host and ${word(report.project)} healthy` : "Host healthy"}\nNo problems found.\n${note ? `${note}\n` : ""}`;
  const lines = ["Problems found"];
  for (const check of failures) {
    lines.push(
      `  ${word(check.name)}: ${word(check.message) || "Check failed."}`,
    );
    if (check.hint) lines.push(`    ${word(check.hint)}`);
  }
  if (note) lines.push(note);
  return `${lines.join("\n")}\n`;
}
export function renderLogs(value: unknown, heading: boolean): string {
  const report = object(value);
  const lines = heading
    ? [`${word(report.project)} ${word(report.target)}`.trim(), ""]
    : [];
  for (const entry of rows(report.entries)) {
    const timestamp = word(entry.timestamp);
    // Timestamps are recorded in UTC; the marker keeps the clock from passing for local time.
    const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(
      timestamp,
    )
      ? `${timestamp.slice(11, 19)}Z`
      : timestamp;
    const marker =
      entry.stream === "stderr"
        ? "!"
        : entry.stream === "stdout"
          ? ">"
          : entry.stream === "health"
            ? "~"
            : "?";
    lines.push(
      `${time}  ${word(entry.component)}  ${marker} ${word(entry.line)}`,
    );
  }
  if (heading && !rows(report.entries).length) lines.push("No logs yet.");
  return lines.length ? `${lines.join("\n")}\n` : "";
}
/** One line per record ending in its Operation id, with the recorded message beneath it. */
function renderActivity(report: Record<string, unknown>): string {
  const operations = rows(report.operations);
  if (!operations.length)
    return word(report.operation)
      ? `No activity recorded for Operation ${word(report.operation)}.\n`
      : "No activity yet.\n";
  const lines = operations.flatMap((operation) => [
    [
      word(operation.occurredAt),
      word(operation.project),
      word(operation.target),
      word(operation.action),
      word(operation.outcome) || "incomplete",
      word(operation.id),
    ]
      .filter(Boolean)
      .join("  "),
    ...(word(operation.message) ? [`    ${word(operation.message)}`] : []),
  ]);
  return `${lines.join("\n")}\n`;
}
export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}
/** A reply field is shown only when it is a string, and then only as terminal-safe text. */
function word(value: unknown): string {
  return typeof value === "string" ? terminalText(value) : "";
}
