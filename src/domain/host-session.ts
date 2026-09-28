/** What identifies the Host's current boot and the user's current login session, as far as either could be read. A field
 * that could not be read is absent; nothing is ever inferred from its absence. */
export interface HostSession {
  /** The kernel's identifier of this boot (`kern.bootsessionuuid`), new at every boot. */
  boot?: string;
  /** When the Mac booted (`kern.boottime`), as an ISO timestamp. Shown to people only: the kernel shifts it when the clock
   * is corrected, so it never decides whether the Mac restarted. */
  bootedAt?: string;
  /** The audit session of the user's GUI login (the launchd `gui/<uid>` domain), new at every login. */
  login?: string;
}

/** Reads the current boot and login session. Never rejects: what it cannot read is left out. */
export interface HostSessionProbe {
  current(): Promise<HostSession>;
}

/** Why every process Rig ran is gone at once: the Mac restarted (`reboot`), or the user logged out and in again (`login`),
 * which ends every launchd job and process of the old login session. */
export type HostRestart = "reboot" | "login";

/** The Host restart between the session rigd last recorded and the current one, or nothing when there was none or it
 * cannot be told. A different boot is a reboot. A different login in the same boot, or in a boot one side could not read,
 * is a new login. With nothing recorded (the first start of a rigd that records sessions) nothing is detected. */
export function hostRestartBetween(
  recorded: HostSession | undefined,
  current: HostSession,
): HostRestart | undefined {
  if (!recorded) return undefined;
  const known = (a?: string, b?: string) => a !== undefined && b !== undefined;
  if (known(recorded.boot, current.boot) && recorded.boot !== current.boot)
    return "reboot";
  if (known(recorded.login, current.login) && recorded.login !== current.login)
    return "login";
  return undefined;
}

/** Whether anything identifying the session was read; a session with neither is never recorded, so the last one that was
 * stays the one the next start compares against. */
export function identified(session: HostSession): boolean {
  return session.boot !== undefined || session.login !== undefined;
}

/** Whether `current` may replace `recorded` when no restart was found between them: only when it read everything the
 * recorded session identifies it by. A boot that could not be read right after a reboot, with an audit session number that
 * repeated, finds nothing; recording that read would forget the boot, and the reboot with it. */
export function mayReplace(
  recorded: HostSession | undefined,
  current: HostSession,
): boolean {
  return (
    identified(current) &&
    (recorded?.boot === undefined || current.boot !== undefined) &&
    (recorded?.login === undefined || current.login !== undefined)
  );
}

/** "the Mac restarted", "you logged out and in again": the restart as Activity and status name it. */
export function hostRestartText(restart: HostRestart): string {
  return restart === "reboot"
    ? "the Mac restarted"
    : "you logged out and in again";
}
