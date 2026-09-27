import type { HostSession, HostSessionProbe } from "../domain/host-session";
import type { CommandRunner } from "./contracts";

/** How long one read of the boot or the login session may take before it counts as unreadable. */
const READ_TIMEOUT_MS = 5_000;

/** Reads the boot from the kernel (`sysctl`) and the login session from launchd (`launchctl print gui/<uid>`).
 * The login session is the audit session of the `gui/<uid>` domain: launchd makes that domain, with a new audit session,
 * at each GUI login and tears it down at logout, whichever process asks. With no GUI login (only SSH, say) there is no
 * such domain and the login session is left out. `launchctl print` also lists the domain's environment, so its output is
 * parsed for that one number and never kept or logged. */
export function createHostSessionProbe(options: {
  run: CommandRunner;
  /** The user whose GUI login is read; rigd's own uid. */
  uid: number;
}): HostSessionProbe {
  const read = async (command: string[]): Promise<string | undefined> => {
    try {
      const result = await options.run({
        command,
        timeoutMs: READ_TIMEOUT_MS,
      });
      return result.exitCode === 0 && !result.timedOut
        ? result.stdout
        : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async current() {
      const [boot, bootedAt, login] = await Promise.all([
        read(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"]),
        read(["/usr/sbin/sysctl", "-n", "kern.boottime"]),
        read(["/bin/launchctl", "print", `gui/${options.uid}`]),
      ]);
      const session: HostSession = {};
      const bootId = boot === undefined ? undefined : parseBootSession(boot);
      if (bootId) session.boot = bootId;
      const booted =
        bootedAt === undefined ? undefined : parseBootTime(bootedAt);
      if (booted) session.bootedAt = booted;
      const loginId =
        login === undefined ? undefined : parseLoginSession(login);
      if (loginId) session.login = loginId;
      return session;
    },
  };
}

/** The boot's identifier from `sysctl -n kern.bootsessionuuid`, or nothing when the output is not one. */
export function parseBootSession(output: string): string | undefined {
  const value = output.trim();
  return /^[0-9A-Fa-f-]{36}$/.test(value) ? value.toUpperCase() : undefined;
}

/** The boot time from `sysctl -n kern.boottime` (`{ sec = 1779656276, usec = 781635 } Sun May 24 ...`) as ISO. */
export function parseBootTime(output: string): string | undefined {
  const match = /\bsec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(output);
  if (!match) return undefined;
  const ms = Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The audit session id of the domain `launchctl print gui/<uid>` describes: the `asid` in the domain's own
 * `security context` block, which comes before the services and anything nested in them. */
export function parseLoginSession(output: string): string | undefined {
  const context = /^\tsecurity context = \{\n([\s\S]*?)^\t\}/m.exec(output);
  const asid = context && /^\t\tasid = (\d+)$/m.exec(context[1]!);
  return asid ? asid[1] : undefined;
}
