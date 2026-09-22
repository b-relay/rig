import type { TargetReport } from "./types";

/** Pure: the colour a lifecycle or outcome word carries; words rigd has not taught the page read as idle. */
export type Tone = "good" | "warn" | "bad" | "busy" | "idle";
const TONES: Record<string, Tone> = {
  healthy: "good",
  running: "good",
  ready: "good",
  installed: "good",
  succeeded: "good",
  starting: "busy",
  configured: "idle",
  stopped: "idle",
  unknown: "warn",
  degraded: "warn",
  cancelled: "warn",
  unhealthy: "bad",
  failed: "bad",
  missing: "bad",
};
export const toneOf = (word: string): Tone => TONES[word] ?? "idle";
export const KIND_LABEL = {
  local: "Working copy",
  live: "Stable",
  preview: "Preview",
} as const;
/** Pure: the first ten characters, enough to name a Commit on one Mac. */
export const shortCommit = (commit: string | undefined) => commit?.slice(0, 10);
/** Pure: an ISO instant as the reader's clock shows it; a string that is no instant is shown as it came. */
export function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
/** Pure: how long ago an instant was, in the coarsest unit that still says something. */
export function ago(iso: string, now: number): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}
/** Pure: the warnings a status report attaches to one Target, in the words the page shows. */
export function targetWarnings(target: TargetReport): string[] {
  return [
    ...(target.routePublished === false
      ? ["The route is not published by Caddy."]
      : []),
    ...(target.deploymentIncomplete
      ? ["The last deploy did not complete."]
      : []),
    ...(target.transitionPending
      ? ["A deployment transition is unresolved."]
      : []),
    ...(target.destructionPending
      ? ["Destruction did not finish; retry Destroy."]
      : []),
  ];
}
/** Pure: whether a Target's route is the host the page was opened on, so stopping it cuts this very page off. */
export const servesHost = (route: string | undefined, host: string): boolean =>
  typeof route === "string" &&
  route.replace(/^https?:\/\//, "").split("/")[0] === host;
