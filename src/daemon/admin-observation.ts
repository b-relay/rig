import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "./client";
import { readDaemonAddress, readDaemonOwner, readDaemonToken } from "./files";
import { RigError } from "../domain/errors";
import { RIG_BUILD } from "../domain/version";
import { recordedProcess, type ProcessRecord } from "./process-identity";
import { installationPath, readInstallationRecord } from "./installation";
import type { DaemonHealth } from "./protocol";

export interface DaemonStatus {
  installed: boolean;
  running: boolean;
  reachable: boolean;
  outcome?: "installed" | "uninstalled" | "unchanged";
  /** The version the reachable daemon reports; absent when unreachable or older than version reporting. */
  version?: string;
  /** The daemon this install stopped and replaced, when it was of another version or command. */
  replaced?: { pid: number; version?: string };
  /** Where the reachable daemon serves the dashboard; absent when it runs none. */
  dashboard?: string;
  warnings?: string[];
}
/** The reachable daemon that the records name, as its health reply describes it. */
export interface ServingDaemon {
  pid: number;
  version?: string;
  dashboard?: string;
  dashboardProblem?: string;
}
/** Status plus what a caller acting on it needs: the ownership records and the hint for records whose pid is alive but
 * cannot be verified as rigd. */
export interface DaemonObservation {
  status: DaemonStatus;
  records: ProcessRecord[];
  unverified?: string;
  /** The reachable daemon's pid and reported version, for an install deciding whether to replace it. */
  serving?: ServingDaemon;
  /** Why the recorded daemon could not be contacted: its credential is empty or unreadable. */
  credential?: RigError;
}

/** What runs under `root` now: whether rigd is installed, whether a recorded process is alive, and whether the daemon the
 * records name answers its health probe. Reads the installation and ownership records, asks the kernel about each recorded
 * pid, and offers the credential only to a port whose recorded owner still runs. */
export async function observeDaemon(root: string): Promise<DaemonObservation> {
  const installed = await installationRecorded(root);
  const address = await readDaemonAddress(root);
  const owner = await readDaemonOwner(root);
  const records = [owner, address].filter(
    (record): record is NonNullable<typeof record> => record !== undefined,
  );
  // A pid alone is not identity: after a crash it may belong to any process.
  const liveness = await Promise.all(records.map(recordedProcess));
  const running = liveness.some(
    (state) => state === "running" || state === "unverified",
  );
  const unverified = liveness.includes("unverified")
    ? unverifiedHint(
        root,
        records.filter((_, index) => liveness[index] === "unverified"),
      )
    : undefined;
  const warnings = [
    ...(installed ? await installationWarnings(root) : []),
    ...(unverified ? [unverified] : []),
  ];
  const observed = (serving?: ServingDaemon, credential?: RigError) => ({
    status: daemonStatus({
      installed,
      running,
      warnings,
      build: RIG_BUILD,
      ...(serving ? { serving } : {}),
      ...(credential ? { credential } : {}),
    }),
    records,
    ...(unverified ? { unverified } : {}),
    ...(serving ? { serving } : {}),
    ...(credential ? { credential } : {}),
  });
  // Never offer the credential to a port whose recorded owner has exited or been replaced.
  const addressLiveness = address
    ? liveness[records.indexOf(address)]
    : "exited";
  if (
    !address ||
    addressLiveness === "exited" ||
    addressLiveness === "replaced"
  )
    return observed();
  let token: string;
  try {
    token = await readDaemonToken(root);
  } catch (error) {
    if (error instanceof RigError && error.code === "DAEMON_TOKEN")
      return observed(undefined, error);
    return observed();
  }
  try {
    const health = await new DaemonClient({
      port: address.port,
      token,
    }).health();
    return observed(servingDaemon(health, address, owner));
  } catch {
    return observed();
  }
}
async function installationRecorded(root: string): Promise<boolean> {
  try {
    await access(installationPath(root));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new RigError(
        "DAEMON_INSTALL_STATE",
        "Cannot read the daemon installation record.",
        "Inspect daemon installation permissions.",
      );
    return false;
  }
}
/** The daemon a health reply describes, when it is the one the records name: the address's pid and instance, and the
 * owner's too when there is an owner record. Undefined for any other process answering on the recorded port. */
export function servingDaemon(
  health: Pick<
    DaemonHealth,
    "pid" | "instanceId" | "version" | "dashboard" | "dashboardProblem"
  >,
  address: { pid: number; instanceId: string },
  owner: { pid: number; instanceId: string } | undefined,
): ServingDaemon | undefined {
  const ours =
    health.instanceId === address.instanceId &&
    health.pid === address.pid &&
    (!owner ||
      (owner.pid === address.pid && owner.instanceId === address.instanceId));
  if (!ours) return undefined;
  return {
    pid: health.pid,
    ...(health.version ? { version: health.version } : {}),
    ...(health.dashboard ? { dashboard: health.dashboard } : {}),
    ...(health.dashboardProblem
      ? { dashboardProblem: health.dashboardProblem }
      : {}),
  };
}
/** The status `rigd status` reports: `warnings` first, then a serving daemon of a build other than `build`, the dashboard's
 * problem, and an unusable credential. */
export function daemonStatus(observed: {
  installed: boolean;
  running: boolean;
  warnings: readonly string[];
  build: string;
  serving?: ServingDaemon;
  credential?: RigError;
}): DaemonStatus {
  const { serving, credential } = observed;
  // A serving daemon of another version is the one thing `rigd install` can change here.
  const skew =
    serving && serving.version !== observed.build
      ? [
          `rigd ${serving.version ?? "of an older version"} is serving, but this rigd is ${observed.build}; run rigd install to upgrade the daemon.`,
        ]
      : [];
  const all = [
    ...observed.warnings,
    ...skew,
    ...(serving?.dashboardProblem
      ? [`Dashboard: ${serving.dashboardProblem}`]
      : []),
    ...(credential ? [`${credential.message} ${credential.hint}`] : []),
  ];
  return {
    installed: observed.installed,
    running: observed.running,
    reachable: serving !== undefined,
    ...(serving?.version ? { version: serving.version } : {}),
    ...(serving?.dashboard ? { dashboard: serving.dashboard } : {}),
    ...(all.length ? { warnings: all } : {}),
  };
}
/** The escape hatch for a live pid that an older rigd recorded without identity. */
export function unverifiedHint(root: string, records: ProcessRecord[]): string {
  const files = [
    join(root, "daemon", "owner.json"),
    join(root, "daemon", "address.json"),
  ];
  const pids = [...new Set(records.map((record) => record.pid))].join(", ");
  return `The recorded daemon pid ${pids} is alive but was recorded by an older rigd without process identity, so it cannot be verified as rigd. If no rigd is running for this root, remove ${files.join(" and ")} and retry.`;
}
/** A recorded program that no longer exists explains an unreachable daemon before anyone reads launchd logs. */
async function installationWarnings(root: string): Promise<string[]> {
  const installation = await readInstallationRecord(root).catch(
    () => undefined,
  );
  const executable = installation?.command?.[0];
  if (!executable) return [];
  try {
    await access(executable, constants.X_OK);
    return [];
  } catch {
    return [
      `The installed daemon program ${executable} is missing or not executable; run rigd install again.`,
    ];
  }
}
