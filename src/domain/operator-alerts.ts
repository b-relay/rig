/** A Service that keeps a Stable Target down, with the reason Rig recorded for it. */
export interface DownService {
  name: string;
  /** The reason status gives for the Service, in full. */
  reason: string;
  /** The same reason in a few words, for a short notification: "unknown exit, not restarted". */
  brief: string;
}

/** How a down period of a Stable Target ended: it runs again, an operator stopped it, or it is no longer recorded. */
export type DowntimeResolution = "running" | "stopped" | "removed";

/** One Stable Target an operator alert is about. */
export interface AlertedTarget {
  project: string;
  target: string;
  /** When Rig first counted it as down, ISO 8601. */
  since: string;
  /** The Services that keep it down. Empty when only its route does. */
  services: DownService[];
  /** Its route, when the host Caddy does not load Rig's routes. */
  unpublishedRoute?: string;
  /** The command that starts it again: `rig up live --project pantry`. */
  recover: string;
  /** For a `recovered` alert: how its down period ended, and when. */
  resolved?: { at: string; how: DowntimeResolution };
}

/** One message to the operator about Stable Targets. `down` names Targets that went down together, `reminder` the ones
 * still down, `recovered` the ones no longer down. Every channel receives the same alert and chooses how much to show. */
export interface OperatorAlert {
  kind: "down" | "reminder" | "recovered";
  /** When Rig composed it, ISO 8601. */
  at: string;
  /** One line: "3 Stable Targets across 3 Projects went down at 13:58:58 UTC". */
  title: string;
  /** A short text for a notification: which Targets and Services, and what to run. */
  summary: string;
  /** Everything Rig knows: each Target, its Services with the reasons Rig recorded, and the command that recovers it. */
  detail: string;
  targets: AlertedTarget[];
}

/** One way an operator alert reaches a person: a macOS notification today, a push channel later. The runtime depends on this
 * capability only; each channel is a provider the composition root selects from the Host config. */
export interface OperatorAlerts {
  /** How Activity names the channel: "macOS notification". */
  readonly channel: string;
  /** Delivers one alert. Rejects, with ALERT_DELIVERY when the channel answered, when it could not. */
  send(alert: OperatorAlert): Promise<void>;
}

/** A Stable Target Rig counts as down, or one whose down period ended but whose recovery the operator was not told yet. */
export interface DownRecord {
  targetId: string;
  project: string;
  target: string;
  /** When Rig first counted it as down, ISO 8601. */
  since: string;
  services: DownService[];
  unpublishedRoute?: string;
  /** The command that starts it again: `rig up live --project pantry`, or a `rig down` first when a deploy left it
   * mid-transition. */
  recover: string;
  /** When the alert naming it was delivered; absent while it is within the grace period or its alert is undelivered. */
  alertedAt?: string;
  /** The down period ended; the record stays until the recovery message is delivered. */
  resolved?: { at: string; how: DowntimeResolution };
}

/** What Rig has alerted about, kept in runtime state so a daemon restart neither repeats nor forgets an alert. */
export interface AlertState {
  targets: DownRecord[];
  /** When the last down alert or reminder was delivered, ISO 8601; reminders are timed from it. */
  notifiedAt?: string;
  /** Deliveries that failed in a row, and when the next one may be tried, ISO 8601. */
  retry?: { failures: number; at: string };
}

/** How long one Stable Target has been down, as doctor and rigd status show it. */
export interface Downtime {
  project: string;
  target: string;
  since: string;
  /** "42 h". */
  down: string;
  /** Whether the operator was alerted about it yet. */
  alerted: boolean;
  recover: string;
}
