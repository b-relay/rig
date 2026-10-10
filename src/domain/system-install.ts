import { createHash } from "node:crypto";

/** Where a system job's plist is staged where only root can write, then installed for launchd. */
export const SYSTEM_STAGING = "/Library/Application Support/Rig";
export const SYSTEM_DAEMONS = "/Library/LaunchDaemons";
/** Where system plists are staged and installed; tests pass temporary directories. */
export interface SystemPlaces {
  readonly staging: string;
  readonly daemons: string;
}
export const DEFAULT_PLACES: SystemPlaces = {
  staging: SYSTEM_STAGING,
  daemons: SYSTEM_DAEMONS,
};

/** One system job to install: its label, the plist Rig rendered, and where that plist sits under the Rig root. */
export interface SystemJob {
  readonly label: string;
  readonly plist: string;
  /** The rendered plist under `<RIG_ROOT>/daemon/launchd/`, which the owner's sudo copies. */
  readonly source: string;
  /** A LaunchAgent this job replaces, removed only once the system plist is verified. */
  readonly replaces?: { readonly domain: string; readonly plist: string };
}
/** A path quoted for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
export function plistDigest(plist: string): string {
  return createHash("sha256").update(plist).digest("hex");
}
/** The one line that installs `job` as a system job, every step gated on the one before (ADR 0014): the plist is copied into a
 * directory only root can write and checked against the digest Rig printed there, before anything reaches
 * /Library/LaunchDaemons or launchd. A source changed after Rig rendered it fails the check, and nothing after it runs. */
export function systemInstallLine(
  job: SystemJob,
  places: SystemPlaces = DEFAULT_PLACES,
): string {
  const staged = `${places.staging}/${job.label}.plist`;
  const installed = `${places.daemons}/${job.label}.plist`;
  return [
    `sudo install -d -m 755 -o root -g wheel ${shellQuote(places.staging)}`,
    `sudo install -m 644 -o root -g wheel ${shellQuote(job.source)} ${shellQuote(staged)}`,
    `echo ${shellQuote(`${plistDigest(job.plist)}  ${staged}`)} | sudo shasum -a 256 -c -`,
    ...(job.replaces
      ? [
          `{ launchctl bootout ${job.replaces.domain}/${job.label} 2>/dev/null; rm -f ${shellQuote(job.replaces.plist)}; true; }`,
        ]
      : []),
    `sudo install -m 644 -o root -g wheel ${shellQuote(staged)} ${shellQuote(installed)}`,
    `{ sudo launchctl bootout system/${job.label} 2>/dev/null; true; }`,
    `sudo launchctl bootstrap system ${shellQuote(installed)}`,
  ].join(" && ");
}
/** The line that removes a system job: it stops it, then deletes both its installed and staged plists. */
export function systemRemoveLine(
  label: string,
  places: SystemPlaces = DEFAULT_PLACES,
): string {
  return [
    `{ sudo launchctl bootout system/${label} 2>/dev/null; true; }`,
    `sudo rm -f ${shellQuote(`${places.daemons}/${label}.plist`)} ${shellQuote(`${places.staging}/${label}.plist`)}`,
  ].join(" && ");
}
