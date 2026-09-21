import type { ProjectStatusReport } from "../domain/project-status";
import { terminalText } from "./terminal-text";
/** Human presenters consume the same domain report returned by structured commands. */
export function renderResult(action: string, value: unknown): string {
  const report = object(value);
  if (action === "list") return renderProjects(report);
  if (action === "doctor") return renderDoctor(report);
  if (action === "config")
    return `${word(report.project)}\n${word(report.path)}\n\n${JSON.stringify(report.config, null, 2)}\n`;
  if (action === "recipe-diff") return renderRecipeDiff(report);
  if (action === "logs") return renderLogs(report, true);
  if (action === "activity") return renderActivity(report);
  if (action === "daemon-status")
    return `Installed  ${report.installed ? "yes" : "no"}\nRunning    ${report.running ? "yes" : "no"}\nReachable  ${report.reachable ? "yes" : "no"}\n${
      report.version ? `Version    ${word(report.version)}\n` : ""
    }${
      Array.isArray(report.warnings)
        ? report.warnings.map((value) => `Warning: ${word(value)}\n`).join("")
        : ""
    }${daemonAdvice(report)}`;
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
/** Both comparisons of each marked Service, in words that claim nothing about a running Service. */
function renderRecipeDiff(report: Record<string, unknown>): string {
  const lines = [`${word(report.project)}  ${word(report.path)}`, ""];
  const findings = rows(report.findings);
  if (!findings.length)
    lines.push(
      "No Service carries a rig-recipe comment, so there is nothing to compare.",
    );
  for (const finding of findings) {
    const service = word(finding.service);
    const origin = `${word(finding.recipe)}@${Number(finding.version)}`;
    if (finding.status === "malformed")
      lines.push(
        `${service}: the recipe comment '${word(finding.marker)}' is not in a form Rig writes; nothing was compared.`,
      );
    else if (finding.status === "unknown-recipe")
      lines.push(
        `${service}: ${origin} is not a recipe bundled with this Rig; nothing was compared.`,
      );
    else if (finding.status === "unknown-version")
      lines.push(
        `${service}: ${origin} is a version this Rig does not bundle; nothing was compared.`,
      );
    else {
      const bundled = `${word(finding.recipe)}@${Number(finding.bundled)}`;
      lines.push(
        origin === bundled
          ? `${service}: ${origin}, the bundled version`
          : `${service}: ${origin}, bundled is ${bundled}`,
      );
      if (finding.generatedAs)
        lines.push(
          `  Generated as '${word(finding.generatedAs)}'; compared as '${service}'.`,
        );
      const update = rows(finding.update);
      const customized = rows(finding.customized);
      if (update.length)
        lines.push(`  Changed in ${bundled}`, ...update.flatMap(changeLines));
      if (customized.length)
        lines.push(
          `  Your changes to ${origin}`,
          ...customized.flatMap(changeLines),
        );
      else lines.push(`  The Service is as ${origin} generated it.`);
      if (update.length)
        lines.push(
          `  Nothing was changed. To see the new block: rig recipe generate ${word(finding.recipe)} --name ${service}`,
        );
    }
  }
  return `${lines.join("\n")}\n`;
}
function changeLines(change: Record<string, unknown>): string[] {
  const path = word(change.path);
  if (change.to === undefined) return [`    - ${path}: ${word(change.from)}`];
  if (change.from === undefined) return [`    + ${path}: ${word(change.to)}`];
  return [
    `    ~ ${path}: ${word(change.to)}`,
    `      was: ${word(change.from)}`,
  ];
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
/** What to do about a daemon that is not serving, or nothing when it is. */
function daemonAdvice(report: Record<string, unknown>): string {
  if (report.reachable === true) return "";
  if (report.installed !== true)
    return "rigd is not installed. Run rigd install.\n";
  if (report.running !== true)
    return "rigd is installed but not running. Run rigd install to start it.\n";
  return "rigd is running but not reachable. Run rig doctor, or rigd uninstall and then rigd install.\n";
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
  const notices = Array.isArray(report.notices)
    ? ["Notices", ...report.notices.map((notice) => `  ${word(notice)}`)]
    : [];
  if (!failures.length && report.ok === true)
    return `${word(report.project) ? `Host and ${word(report.project)} healthy` : "Host healthy"}\nNo problems found.\n${note ? `${note}\n` : ""}${notices.map((line) => `${line}\n`).join("")}`;
  const lines = ["Problems found"];
  for (const check of failures) {
    lines.push(
      `  ${word(check.name)}: ${word(check.message) || "Check failed."}`,
    );
    if (check.hint) lines.push(`    ${word(check.hint)}`);
  }
  if (note) lines.push(note);
  lines.push(...notices);
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
