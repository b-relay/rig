/** Human presenters consume the same domain report returned by structured commands. */
export function renderResult(action: string, value: unknown): string {
  const report = object(value);
  if (action === "list") return renderProjects(report);
  if (action === "status") return renderStatus(report);
  if (action === "doctor") return renderDoctor(report);
  if (action === "config")
    return `${word(report.project)}\n${word(report.path)}\n\n${JSON.stringify(report.config, null, 2)}\n`;
  if (action === "logs") return renderLogs(report, true);
  if (action === "activity") return renderActivity(report);
  if (action === "daemon-status")
    return `Installed  ${report.installed ? "yes" : "no"}\nRunning    ${report.running ? "yes" : "no"}\nReachable  ${report.reachable ? "yes" : "no"}\n`;
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
  const warnings = Array.isArray(report.warnings)
    ? report.warnings.map((value) => `Warning: ${word(value)}\n`).join("")
    : "";
  return `${subject} ${outcome}${path}\n${warnings}`;
}
function renderProjects(report: Record<string, unknown>): string {
  const projects = rows(report.projects);
  return projects.length
    ? `${projects.map((project) => `${word(project.name)}  ${Number(project.targetCount ?? 0)} Targets  ${word(project.repoPath)}`).join("\n")}\n`
    : "No Projects registered.\n";
}
function renderStatus(report: Record<string, unknown>): string {
  const lines = [word(report.project)];
  const failures: string[] = [];
  for (const target of rows(report.targets)) {
    lines.push(
      "",
      [
        word(target.name),
        word(target.state),
        word(target.branch) || (target.kind === "local" ? "working copy" : ""),
      ]
        .filter(Boolean)
        .join("  "),
    );
    if (
      target.route &&
      !rows(target.components).some((component) => component.route)
    )
      lines.push(`  Route  ${word(target.route)}`);
    for (const component of rows(target.components)) {
      const port =
        typeof component.port === "number" ? `:${component.port}` : "";
      const route = word(component.route);
      lines.push(
        `  ${[word(component.name), word(component.state), port, route].filter(Boolean).join("  ")}`,
      );
      if (["failed", "unhealthy", "missing"].includes(word(component.state)))
        failures.push(
          `${word(target.name)} ${word(component.name)}: ${word(component.reason) || word(component.state)}`,
        );
      if (component.state === "unknown" && component.reason)
        lines.push(`    ${word(component.reason)}`);
    }
  }
  if (!rows(report.targets).length) lines.push("", "No Targets configured.");
  if (failures.length)
    lines.push("", "Failures", ...failures.map((failure) => `  ${failure}`));
  else lines.push("", "No failures");
  if (
    rows(report.targets).some(
      (target) =>
        target.state === "unknown" ||
        rows(target.components).some(
          (component) => component.state === "unknown",
        ),
    )
  )
    lines.push("Some observations are unknown.");
  for (const warning of Array.isArray(report.warnings) ? report.warnings : [])
    lines.push(`Warning: ${word(warning)}`);
  return `${lines.join("\n")}\n`;
}
function renderDoctor(report: Record<string, unknown>): string {
  const failures = rows(report.checks).filter((check) => check.ok !== true);
  if (!failures.length && report.ok === true)
    return `${word(report.project) ? `Host and ${word(report.project)} healthy` : "Host healthy"}\nNo problems found.\n`;
  const lines = ["Problems found"];
  for (const check of failures) {
    lines.push(
      `  ${word(check.name)}: ${word(check.message) || "Check failed."}`,
    );
    if (check.hint) lines.push(`    ${word(check.hint)}`);
  }
  return `${lines.join("\n")}\n`;
}
export function renderLogs(value: unknown, heading: boolean): string {
  const report = object(value);
  const lines = heading
    ? [`${word(report.project)} ${word(report.target)}`.trim(), ""]
    : [];
  for (const entry of rows(report.entries)) {
    const timestamp = word(entry.timestamp);
    const time = /^\d{4}-\d{2}-\d{2}T/.test(timestamp)
      ? timestamp.slice(11, 19)
      : timestamp;
    const marker =
      entry.stream === "stderr" ? "!" : entry.stream === "stdout" ? ">" : "?";
    lines.push(
      `${time}  ${word(entry.component)}  ${marker} ${word(entry.line)}`,
    );
  }
  if (heading && !rows(report.entries).length) lines.push("No logs yet.");
  return lines.length ? `${lines.join("\n")}\n` : "";
}
function renderActivity(report: Record<string, unknown>): string {
  const operations = rows(report.operations);
  return operations.length
    ? `${operations.map((operation) => [word(operation.occurredAt), word(operation.project), word(operation.target), word(operation.action), word(operation.outcome) || "incomplete"].filter(Boolean).join("  ")).join("\n")}\n`
    : "No activity yet.\n";
}
export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}
/** Terminal fields cannot inject another line or an ANSI terminal command. */
function word(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\x00-\x1f\x7f]/g, " ")
    : "";
}
