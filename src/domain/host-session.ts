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

/** The session to record now: every field read now, and the recorded value of any field that could not be, so the next
 * start still compares against the last value known. */
export function sessionToRecord(
  recorded: HostSession | undefined,
  current: HostSession,
): HostSession {
  return {
    ...pick(recorded),
    ...pick(current),
  };
}
function pick(session: HostSession | undefined): HostSession {
  return {
    ...(session?.boot === undefined ? {} : { boot: session.boot }),
    ...(session?.bootedAt === undefined ? {} : { bootedAt: session.bootedAt }),
    ...(session?.login === undefined ? {} : { login: session.login }),
  };
}

/** "the Mac restarted", "you logged out and in again": the restart as Activity and status name it. */
export function hostRestartText(restart: HostRestart): string {
  return restart === "reboot"
    ? "the Mac restarted"
    : "you logged out and in again";
}
