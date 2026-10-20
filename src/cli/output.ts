import {
  healthSummary,
  type JobReport,
  type ProjectStatusReport,
} from "../domain/project-status";
import { formatBytes } from "../domain/bytes";
import { killingText } from "./stop-display";
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
  if (action === "proxy") return renderProxy(report);
  if (action === "backups") return renderBackups(report);
  if (action === "dns") return renderDns(report);
  if (["dns-create", "dns-update", "dns-delete"].includes(action))
    return `${capitalized(word(report.summary)) || "DNS record changed"}.\n`;
  if (action === "proxy-apply" && report.outcome === "withdrawn")
    return Array.isArray(report.withdrawn) && report.withdrawn.length
      ? `Withdrew routes no recorded Target owned: ${report.withdrawn.map(word).join(", ")}.\n`
      : "No route without a recorded Target to withdraw. Rig does not run its own Caddy on this Host, so there is no proxy section to apply.\n";
  if (action === "proxy-apply")
    return `Rig's Caddy serves the proxy section of Host config as it is now, proxy.routes included.\n${
      Array.isArray(report.withdrawn) && report.withdrawn.length
        ? `Withdrew routes no recorded Target owned: ${report.withdrawn.map(word).join(", ")}.\n`
        : ""
    }`;
  if (action === "daemon-upgrade") {
    const release = word(report.release);
    const installed = word(report.installed);
    if (report.outcome === "upgraded")
      return installed
        ? `Upgraded Rig from ${installed} to ${release}.\n`
        : `Installed Rig ${release}.\n`;
    if (report.outcome === "available")
      return `Rig ${release} is available; ${installed ? `${installed} is installed` : "none is installed"}. Run rigd upgrade${report.named === true ? ` ${release}` : ""} to install it.\n`;
    return report.named === true
      ? `Rig ${release} is already installed.\n`
      : `Rig ${installed} is installed, the latest release.\n`;
  }
  if (action === "daemon-status")
    return `Installed  ${report.installed ? "yes" : "no"}\nRunning    ${report.running ? "yes" : "no"}\nReachable  ${report.reachable ? "yes" : "no"}\n${
      report.version ? `Version    ${word(report.version)}\n` : ""
    }${report.dashboard ? `Dashboard  ${word(report.dashboard)}\n` : ""}${
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
  if (action === "run")
    return `${[subject, word(report.job)].filter(Boolean).join(" ")} ${outcome}\n`;
  if (action === "restore") {
    const ended = object(report.ended);
    return `${[subject, word(report.job)].filter(Boolean).join(" ")} ${
      outcome === "restored"
        ? `restored from ${word(report.backup)}${
            typeof ended.message === "string"
              ? ` (${word(ended.message).replace(/^[^:]*: (?:restore from \S+ )?/, "")})`
              : ""
          }`
        : `restore from ${word(report.backup)} ${outcome}`
    }\n`;
  }
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
  // ADR 0016: the Services the deploy left running from the checkout they were started in.
  const kept =
    action === "deploy" && Array.isArray(report.kept) && report.kept.length
      ? `, kept ${report.kept.map(word).join(", ")}`
      : "";
  const warnings = [
    ...(Array.isArray(report.warnings)
      ? report.warnings.map((value) => `Warning: ${word(value)}\n`)
      : []),
  ].join("");
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
  return `${retired}${subject} ${outcome}${upgrade}${revision}${kept}${path}\n${warnings}`;
}
/** `rig backup list`: one line per backup, newest first, `stable  db-backup  20261011T030000Z-17  2026-10-11 03:00:41Z  13 MB
 * schedule  run 1a2b3c4d`, then where they are. */
function renderBackups(report: Record<string, unknown>): string {
  const backups = rows(report.backups);
  if (!backups.length)
    return "No backups. A job with backup: in rig.yaml keeps one per successful run (rig run <job> makes one now).\n";
  const lines = backups.map((backup) =>
    [
      word(backup.target),
      word(backup.job),
      word(backup.id),
      word(backup.finishedAt)
        .replace("T", " ")
        .replace(/\.\d+Z$/, "Z"),
      typeof backup.bytes === "number" ? formatBytes(backup.bytes) : "?",
      word(backup.trigger) === "schedule" ? "schedule" : "rig run",
      `run ${word(backup.run).slice(0, 8)}`,
      backup.missing === true ? "MISSING (directory deleted)" : "",
    ]
      .filter(Boolean)
      .join("  "),
  );
  const first = word(backups[0]!.path);
  const root = first.replace(/\/[^/]+\/[^/]+\/[^/]+$/, "");
  return `${lines.join("\n")}\n${root ? `\nIn ${root}/<target>/<job>/<id>\n` : ""}`;
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
/** `now` is the local clock a stopping Service's kill deadline is shown against. */
export function renderStatus(report: ProjectStatusReport, now: Date): string {
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
    // A hostname is shown beside the Service its '/' reaches; one no Service line shows gets a Route line of its own.
    const reached = (component: (typeof target.components)[number]) =>
      component.hostnames ?? (component.route ? [component.route] : []);
    const shown = new Set(target.components.flatMap(reached));
    for (const hostname of target.hostnames ??
      (target.route ? [target.route] : []))
      if (!shown.has(hostname))
        lines.push(
          `  Route  ${[word(hostname), unpublished].filter(Boolean).join("  ")}`,
        );
    for (const component of target.components) {
      const port = component.port !== undefined ? `:${component.port}` : "";
      const hostnames = reached(component);
      const route = hostnames.length
        ? [hostnames.map(word).join(", "), unpublished]
            .filter(Boolean)
            .join("  ")
        : "";
      const state =
        component.state === "stopping" && typeof component.killAt === "string"
          ? `stopping · ${killingText(component.killAt, now, "minutes", false)}`
          : word(healthSummary(component, now)) || word(component.state);
      lines.push(
        `  ${[word(component.name), state, port, route, keptFrom(target, component)].filter(Boolean).join("  ")}`,
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
    const jobs = Array.isArray(target.jobs) ? target.jobs : [];
    if (jobs.length) lines.push("  Jobs");
    for (const job of jobs) {
      lines.push(
        `    ${[word(job.name), jobSummary(job, now)].filter(Boolean).join("  ")}`,
      );
      if (job.backup) lines.push(`      ${backupLine(job.backup, now)}`);
      if (job.reason) lines.push(`      ${word(job.reason)}`);
      if (
        job.last?.outcome &&
        ["failed", "timed-out", "start-failed"].includes(job.last.outcome)
      )
        failures.push(
          `${word(target.name)} ${word(job.name)}: last run ${word(job.last.summary)}`,
        );
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
/** One line about a job: its schedule, what runs or last ran, and when it runs next, such as
 * `17 0-23/6 * * * America/Chicago · last succeeded in 3m12s, 2h ago · next Sat 18:17 CDT (in 4h)`. */
function jobSummary(job: JobReport, now: Date): string {
  const zone = word(job.timeZone);
  const parts = [
    job.removed ? "removed" : `${word(job.schedule)} ${zone}`.trim(),
  ];
  if (job.running)
    parts.push(
      `running since ${clock(job.running.startedAt, zone)} (${ago(job.running.startedAt, now)})`,
    );
  if (job.last)
    parts.push(
      `last ${word(job.last.summary)}, ${ago(job.last.finishedAt ?? job.last.startedAt, now)} ago`,
    );
  else if (!job.running) parts.push("not run yet");
  if (job.nextRunAt)
    parts.push(
      `next ${clock(job.nextRunAt, zone)} (in ${until(job.nextRunAt, now)})`,
    );
  return parts.join(" · ");
}
/** A backup job's backups on one line: `backups 3 of 14 kept, 41 MB · latest 20261011T030000Z-17, 9h ago`. */
function backupLine(
  backup: NonNullable<JobReport["backup"]>,
  now: Date,
): string {
  const parts = [
    `backups ${backup.count} of ${backup.keep} kept, ${formatBytes(backup.bytes)}`,
  ];
  if (backup.latest)
    parts.push(
      `latest ${word(backup.latest.id)}, ${ago(backup.latest.finishedAt, now)} ago`,
    );
  if (!backup.restore) parts.push("no restore command");
  return parts.join(" · ");
}
/** `Sat 18:17 CDT`: a time as the job's zone reads it, or as given when it cannot be read. */
function clock(at: unknown, timeZone: string): string {
  const instant = typeof at === "string" ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(instant)) return word(at);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(new Date(instant));
  } catch {
    return word(at);
  }
}
/** "45s", "12m", "3h", "2d" between two times. */
function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
function ago(at: unknown, now: Date): string {
  const instant = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(instant) ? span(now.getTime() - instant) : "?";
}
function until(at: unknown, now: Date): string {
  const instant = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(instant) ? span(instant - now.getTime()) : "?";
}
/** `kept from 1a2b3c4` for a Service a deploy kept running from an earlier Commit than its Target's (ADR 0016). */
function keptFrom(
  target: Pick<ProjectStatusReport["targets"][number], "commit">,
  component: Pick<
    ProjectStatusReport["targets"][number]["components"][number],
    "commit"
  >,
): string {
  const commit = word(component.commit);
  return commit && target.commit && commit !== target.commit
    ? `kept from ${commit.slice(0, 7)}`
    : "";
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
  return target.kind === "working" ? "working copy" : "";
}
/** `rig proxy`: the job, then one line per served hostname with what it reaches: a Target's paths, or one of the owner's
 * proxy.routes. */
function renderProxy(report: Record<string, unknown>): string {
  const caddy = object(report.caddy);
  const ports = object(caddy.ports);
  const lines = [
    `Caddy      ${word(caddy.state)} on ports ${Number(ports.http)} and ${Number(ports.https)}, certificates from ${word(caddy.ca)}`,
    ...(caddy.generation ? [`Generation ${word(caddy.generation)}`] : []),
    "",
  ];
  const sites = rows(report.sites);
  if (!sites.length) lines.push("No site is served.");
  for (const site of sites) {
    const owner =
      site.source === "custom"
        ? "proxy.routes"
        : `${word(site.project)} ${word(site.target)}`;
    const routes =
      site.source === "custom"
        ? `/ -> ${site.upstream === null ? "withheld (503)" : word(site.upstream)}`
        : rows(site.routes)
            .map(
              (route) =>
                `${word(route.prefix)} -> ${route.upstream === null ? "withheld (503)" : word(route.upstream)}`,
            )
            .join(", ");
    lines.push(
      `${word(site.hostname)}  ${owner}${routes ? `  ${routes}` : ""}${site.certificate ? `  [${word(site.certificate)}]` : ""}`,
    );
  }
  // What is above is what Caddy serves; Host config it has not taken is shown apart, with why.
  if (report.pending !== undefined) {
    const pending = object(report.pending);
    const fields = Array.isArray(pending.fields)
      ? pending.fields.map(String)
      : [];
    lines.push(
      "",
      `Pending    proxy settings in config.yaml${fields.length ? ` (${fields.map(word).join(", ")})` : ""} are not served: ${word(pending.reason)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
const capitalized = (text: string) =>
  text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
/** `rig dns list`: each zone's records, then every hostname Rig serves and whether it points at this Mac. */
function renderDns(report: Record<string, unknown>): string {
  const address = word(report.address);
  const lines = [
    address
      ? `This Mac   ${address} (${report.addressSource === "config" ? "proxy.dns.address" : "Tailscale"})`
      : "This Mac   address unknown: set proxy.dns.address, or install Tailscale",
  ];
  const unseen = Array.isArray(report.unseenZones)
    ? report.unseenZones.map(word)
    : [];
  if (unseen.length)
    lines.push(
      `Warning: the token cannot see ${unseen.join(", ")} from proxy.dns.zones.`,
    );
  for (const failure of rows(report.unreadableZones))
    lines.push(
      `Warning: the records of ${word(failure.zone)} could not be read (${word(failure.code)}): ${word(failure.message)}`,
    );
  const records = rows(report.records);
  const zones = rows(report.zones);
  if (!zones.length) lines.push("", "The DNS token sees no zone.");
  for (const zone of zones) {
    const own = records.filter((record) => record.zone === zone.name);
    lines.push("", `${word(zone.name)}  ${own.length} records`);
    const width = Math.min(
      40,
      Math.max(0, ...own.map((record) => word(record.name).length)),
    );
    for (const record of own) {
      const ttl =
        Number(record.ttl) === 1 ? "auto" : String(Number(record.ttl));
      const extra = [
        record.priority !== undefined
          ? `priority ${Number(record.priority)}`
          : "",
        record.proxied === true ? "proxied" : "",
        `ttl ${ttl}`,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `  ${word(record.name).padEnd(width)}  ${word(record.type).padEnd(5)}  ${word(record.content)}  (${extra})`,
      );
    }
  }
  const hostnames = rows(report.hostnames);
  if (hostnames.length) {
    lines.push("", "Hostnames Rig serves");
    for (const check of hostnames) {
      const mark =
        check.verdict === "mac"
          ? "ok     "
          : check.verdict === "unknown"
            ? "?      "
            : "FIX    ";
      lines.push(`  ${mark}${word(check.hostname)}  ${word(check.reason)}`);
      const fix = object(check.fix);
      const record = object(fix.record);
      if (check.fix !== undefined)
        lines.push(
          `         rig dns set ${word(record.name)} A ${word(record.content)}${fix.op === "update" ? " --no-proxied" : ""}`,
        );
      else if (check.fixBlocked)
        lines.push(`         ${word(check.fixBlocked)}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
/** The longest log line rig prints whole unless asked for --full. Rig records up to 64K characters per line, which would
 * flood a terminal or an agent's context. */
export const LONG_LINE_CHARS = 2000;
/** Pure: a logs reply with every line longer than LONG_LINE_CHARS cut there, each such entry gaining `omitted`, the
 * characters left out; the reply unchanged with `full`. */
export function shortenedLogs(value: unknown, full: boolean): unknown {
  const report = object(value);
  if (full || !Array.isArray(report.entries)) return value;
  return {
    ...report,
    entries: report.entries.map((entry: unknown) => {
      const fields = object(entry);
      if (
        typeof fields.line !== "string" ||
        fields.line.length <= LONG_LINE_CHARS
      )
        return entry;
      // Cut by code point, so no character is split in half.
      const characters = Array.from(fields.line);
      if (characters.length <= LONG_LINE_CHARS) return entry;
      return {
        ...fields,
        line: characters.slice(0, LONG_LINE_CHARS).join(""),
        omitted: characters.length - LONG_LINE_CHARS,
      };
    }),
  };
}
/** Pure: the records of a logs or activity reply as JSON Lines, one object per line, for a file a program reads
 * record by record. */
export function jsonLines(action: string, value: unknown): string {
  const report = object(value);
  const items = action === "logs" ? report.entries : report.operations;
  return Array.isArray(items)
    ? items.map((item) => `${JSON.stringify(item)}\n`).join("")
    : "";
}
/** Pure: what a logs or activity read left out, for stderr, so a program reading stdout gets only the records:
 * `showing 20 of 340 records; --lines to see more`. Undefined when nothing was left out. */
export function readNotice(action: string, value: unknown): string | undefined {
  const report = object(value);
  if (action === "activity" && typeof report.total === "number") {
    const shown = rows(report.operations).length;
    return report.total > shown
      ? `showing ${shown} of ${report.total} records; --lines or --until to see more`
      : undefined;
  }
  if (action === "logs" && report.more === true) {
    const shown = rows(report.entries).length;
    return `showing the latest ${shown} ${shown === 1 ? "entry" : "entries"}; older ones match too, --lines or --since to see them`;
  }
  return undefined;
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
    const omitted =
      typeof entry.omitted === "number"
        ? ` … (${entry.omitted.toLocaleString("en-US")} more characters)`
        : "";
    lines.push(
      `${time}  ${word(entry.component)}  ${marker} ${word(entry.line)}${omitted}`,
    );
  }
  if (heading && !rows(report.entries).length)
    lines.push(
      report.filtered === true ? "No matching log lines." : "No logs yet.",
    );
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
