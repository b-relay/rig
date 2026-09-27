import type {
  AlertState,
  AlertedTarget,
  DownRecord,
  Downtime,
  DowntimeResolution,
  OperatorAlert,
} from "../domain/operator-alerts";
import type { OperationRecord } from "../domain/runtime";

/** The command that starts a Stable Target again. */
export function recoverCommand(
  record: Pick<DownRecord, "project" | "target">,
): string {
  return `rig up ${record.target} --project ${record.project}`;
}

/** A duration as doctor and alerts say it: "under 1 min", "12 min", "42 h", "5 d". */
export function downFor(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 72 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/** "13:58:58 UTC" on the same UTC day as `reference`, "2026-09-25 13:58:58 UTC" on another. */
export function utcClock(iso: string, reference: string): string {
  const [date, time] = new Date(iso).toISOString().split("T") as [
    string,
    string,
  ];
  const clock = `${time.slice(0, 8)} UTC`;
  return date === new Date(reference).toISOString().slice(0, 10)
    ? clock
    : `${date} ${clock}`;
}

/** The alert of `kind` about `records`, composed at `now`. */
export function composeAlert(
  kind: OperatorAlert["kind"],
  records: readonly DownRecord[],
  now: string,
): OperatorAlert {
  const text =
    kind === "down"
      ? downText(records, now)
      : kind === "reminder"
        ? reminderText(records, now)
        : recoveredText(records, now);
  return { kind, at: now, ...text, targets: records.map(alertedTarget) };
}

/** What Activity records about an alert once it was delivered, or once no channel was there to deliver it. The outcome is
 * what the alert says of the Targets: `failed` for gone down, `unchanged` for still down, `started` or `stopped` for no
 * longer down. */
export function sentActivity(
  alert: OperatorAlert,
  channels: readonly string[],
): Pick<OperationRecord, "action" | "outcome" | "message"> {
  const outcome =
    alert.kind === "down"
      ? "failed"
      : alert.kind === "reminder"
        ? "unchanged"
        : alert.targets.some((target) => target.resolved?.how === "running")
          ? "started"
          : "stopped";
  const sent = channels.length
    ? `Sent as a ${channels.join(" and a ")}.`
    : "No alert channel is enabled in the Host config, so nothing was sent.";
  return { action: "outage", outcome, message: `${alert.detail} ${sent}` };
}

/** What Activity records when `channel` could not deliver `alert`. `retryAt` is when Rig tries again, when no other channel
 * delivered it. */
export function deliveryFailureActivity(
  alert: OperatorAlert,
  channel: string,
  failure: string,
  retryAt: string | undefined,
): Pick<OperationRecord, "action" | "outcome" | "message"> {
  const next = retryAt
    ? `Rig tries again at ${utcClock(retryAt, alert.at)}.`
    : "Another channel delivered it.";
  return {
    action: "alert",
    outcome: "failed",
    message: `The ${channel} "${alert.title}" could not be delivered: ${trimPeriod(failure)}. ${next}`,
  };
}

/** How long each Stable Target Rig counts as down has been down at `now`, earliest first. */
export function downtimeReport(
  state: AlertState | undefined,
  now: string,
): Downtime[] {
  return (state?.targets ?? [])
    .filter((record) => !record.resolved)
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
    .map((record) => ({
      project: record.project,
      target: record.target,
      since: record.since,
      down: downFor(Date.parse(now) - Date.parse(record.since)),
      alerted: record.alertedAt !== undefined,
      recover: recoverCommand(record),
    }));
}

function alertedTarget(record: DownRecord): AlertedTarget {
  return {
    project: record.project,
    target: record.target,
    since: record.since,
    services: record.services,
    ...(record.unpublishedRoute
      ? { unpublishedRoute: record.unpublishedRoute }
      : {}),
    recover: recoverCommand(record),
    ...(record.resolved ? { resolved: record.resolved } : {}),
  };
}

type AlertText = Pick<OperatorAlert, "title" | "summary" | "detail">;

function downText(records: readonly DownRecord[], now: string): AlertText {
  const [first] = records;
  const since = earliest(records.map((record) => record.since));
  const title = `${records.length === 1 ? named(first!) : scope(records)} went down at ${utcClock(since, now)}`;
  return {
    title,
    summary:
      records.length === 1
        ? `${causes(first!, "brief")}. Run ${recoverCommand(first!)}.`
        : `${records.map((record) => `${named(record)} (${causeNames(record)})`).join(", ")}. ${SEE_ACTIVITY}`,
    detail: `${title}. ${records.map((record) => `${named(record)}: ${causes(record, "reason")}. Run ${recoverCommand(record)}.`).join(" ")}`,
  };
}

function reminderText(records: readonly DownRecord[], now: string): AlertText {
  const [first] = records;
  const down = (record: DownRecord) =>
    downFor(Date.parse(now) - Date.parse(record.since));
  const title =
    records.length === 1
      ? `${named(first!)} is still down (${down(first!)})`
      : `${counted(records.length, "Stable Target")} are still down`;
  return {
    title,
    summary:
      records.length === 1
        ? `Down since ${utcClock(first!.since, now)}: ${causes(first!, "brief")}. Run ${recoverCommand(first!)}.`
        : `${records.map((record) => `${named(record)} (down ${down(record)})`).join(", ")}. ${SEE_ACTIVITY}`,
    detail: `${title}. ${records.map((record) => `${named(record)}, down ${down(record)} since ${utcClock(record.since, now)}: ${causes(record, "reason")}. Run ${recoverCommand(record)}.`).join(" ")}`,
  };
}

const ENDED: Record<DowntimeResolution, string> = {
  running: "is back up",
  stopped: "was stopped with rig down",
  removed: "is no longer recorded",
};

function recoveredText(records: readonly DownRecord[], now: string): AlertText {
  const [first] = records;
  const lasted = (record: DownRecord) =>
    downFor(Date.parse(record.resolved!.at) - Date.parse(record.since));
  const title =
    records.length === 1
      ? `${named(first!)} ${ENDED[first!.resolved!.how]}`
      : `${counted(records.length, "Stable Target")} are no longer down`;
  return {
    title,
    summary:
      records.length === 1
        ? `It was down ${lasted(first!)}.`
        : `${records.map((record) => `${named(record)} ${ENDED[record.resolved!.how]} after ${lasted(record)} down`).join("; ")}.`,
    detail: `${title}. ${records.map((record) => `${named(record)} ${ENDED[record.resolved!.how]} at ${utcClock(record.resolved!.at, now)}, after ${lasted(record)} down since ${utcClock(record.since, now)}.`).join(" ")}`,
  };
}

const SEE_ACTIVITY = "Run rig activity for the reasons and commands.";

function named(record: Pick<DownRecord, "project" | "target">): string {
  return `${record.project} ${record.target}`;
}

/** "3 Stable Targets across 3 Projects". */
function scope(records: readonly DownRecord[]): string {
  const projects = new Set(records.map((record) => record.project)).size;
  return `${counted(records.length, "Stable Target")} across ${counted(projects, "Project")}`;
}

/** "convex: unknown exit, not restarted; route pantry.example.com is not published", in brief or with full reasons. */
function causes(record: DownRecord, form: "brief" | "reason"): string {
  return [
    ...record.services.map(
      (service) => `${service.name}: ${trimPeriod(service[form])}`,
    ),
    ...(record.unpublishedRoute
      ? [
          `its route ${record.unpublishedRoute} is not published, because no host Caddyfile loads Rig's routes`,
        ]
      : []),
  ].join("; ");
}

/** "convex, web", or "route" when only the route keeps it down. */
function causeNames(record: DownRecord): string {
  return [
    ...record.services.map((service) => service.name),
    ...(record.unpublishedRoute ? ["route"] : []),
  ].join(", ");
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function earliest(times: readonly string[]): string {
  return times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}

function trimPeriod(text: string): string {
  return text.trim().replace(/\.$/, "");
}
