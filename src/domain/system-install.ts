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
    // The user's own shell opens the source and root only writes what it is handed, so a source swapped for a link to a
    // root-only file reads nothing root can; the staged copy is root's and private until its digest is checked.
    `sudo sh -c ${shellQuote(`umask 077; cat > ${shellQuote(staged)}`)} < ${shellQuote(job.source)}`,
    `{ echo ${shellQuote(`${plistDigest(job.plist)}  ${staged}`)} | sudo shasum -a 256 -c - || { sudo rm -f ${shellQuote(staged)}; false; }; }`,
    ...(job.replaces
      ? [
          stopped(`${job.replaces.domain}/${job.label}`, false),
          `rm -f ${shellQuote(job.replaces.plist)}`,
        ]
      : []),
    `sudo install -m 644 -o root -g wheel ${shellQuote(staged)} ${shellQuote(installed)}`,
    stopped(`system/${job.label}`, true),
    // A job the emergency rollback disabled stays disabled across reboots until it is enabled again, here.
    `sudo launchctl enable system/${job.label}`,
    `sudo launchctl bootstrap system ${shellQuote(installed)}`,
  ].join(" && ");
}
/** A step that succeeds only once `target` is confirmed not loaded: a job launchd does not know is fine; a loaded one is
 * booted out and must then be gone within twenty seconds, long enough for rigd's drain. What decides is launchd saying the
 * job is gone, not bootout's exit status, which is non-zero while a stop is still in progress; a job still loaded at the
 * end fails the step, so nothing after it runs. */
export function stopped(target: string, sudo: boolean): string {
  const launchctl = `${sudo ? "sudo " : ""}launchctl`;
  const absent = `! ${launchctl} print ${target} >/dev/null 2>&1`;
  const waits = Array.from({ length: 20 }, (_, index) => index + 1).join(" ");
  return `{ ${absent} || { ${launchctl} bootout ${target}; for wait in ${waits}; do ${absent} && break; sleep 1; done; ${absent}; }; }`;
}
/** The line that removes a system job: it stops it (only a confirmed stop lets the line go on), then deletes both its
 * installed and staged plists. */
export function systemRemoveLine(
  label: string,
  places: SystemPlaces = DEFAULT_PLACES,
): string {
  return [
    stopped(`system/${label}`, true),
    `sudo rm -f ${shellQuote(`${places.daemons}/${label}.plist`)} ${shellQuote(`${places.staging}/${label}.plist`)}`,
  ].join(" && ");
}
