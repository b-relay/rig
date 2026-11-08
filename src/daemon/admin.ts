import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateDirectory } from "../providers/private-files";
import { securePrivateRoot } from "./private-root";
import { DaemonClient } from "./client";
import { daemonTokenPath, readDaemonAddress, readDaemonToken } from "./files";
import { RigError } from "../domain/errors";
import { RIG_BUILD } from "../domain/version";
import { processExists } from "./host";
import { recordedProcess, type ProcessRecord } from "./process-identity";
import { clearStartupFailure, readStartupFailure } from "./startup-failure";
import { daemonEnvironment } from "./environment";
import {
  installationPath,
  installLockPath,
  type DaemonMode,
} from "./installation";
import type { ProxyInstallation } from "./proxy-installation";
import { DEFAULT_PLACES, type SystemPlaces } from "../domain/system-install";
import { z } from "zod";
import {
  createAdminActivityJournal,
  type AdminActivityJournal,
} from "../adapters/admin-activity";
import {
  acquireProcessLock,
  inheritProcessLock,
} from "../adapters/process-lock";
import {
  observeDaemon,
  type DaemonStatus,
  type ServingDaemon,
} from "./admin-observation";
import {
  installationRecord,
  issueToken,
  readInstallation,
  removeRecordAndToken,
  writeInstallation,
} from "./admin-records";
import { recordedAsWanted } from "./admin-replacement";
import type { DaemonLauncher } from "./admin-launcher";
import { createDaemonProcess } from "./admin-process";
import {
  createLaunchAgent,
  runLaunchctl,
  type LaunchctlRunner,
} from "./admin-launch-agent";
import {
  installSystemDaemon,
  systemJobsRemain,
  systemLeftovers,
  systemRemovalRequired,
  type SystemInstall,
} from "./admin-system-jobs";
import { pause, prepareStop, stopsWithin } from "./admin-stop";

export type { DaemonStatus } from "./admin-observation";
export type { LaunchctlRunner } from "./admin-launch-agent";

export interface DaemonAdminOptions {
  root: string;
  command: readonly string[];
  /** The bun recorded for Tools whose `bin` is a source file (see resolveToolBun); absent when none was found. */
  bun?: string;
  mode: "process" | "launchd";
  userHome: string;
  uid?: number;
  stopTimeoutMs?: number;
  activity?: AdminActivityJournal;
  /** Runs launchctl with the given arguments; defaults to /bin/launchctl. */
  launchctl?: LaunchctlRunner;
  /** Sets up and takes down Rig's Caddy (ADR 0014); absent where no Caddy is ever managed, such as tests of the daemon alone. */
  proxy?: ProxyInstallation;
  /** daemon.start in Host config: whether a launchd install is a system job that runs from boot. Login when absent. */
  start?: () => Promise<"login" | "boot">;
  /** Where a rigd started now would serve the dashboard (Host config and the installed release); undefined when it would
   * serve none. A running rigd that reports another is restarted, so a changed setting applies. Absent, it is not
   * compared. */
  dashboard?: () => Promise<string | undefined>;
  /** The account system jobs run as: the installing user. */
  userName?: string;
  /** Where system plists are staged and installed; tests pass temporary directories. */
  systemPlaces?: SystemPlaces;
  /** A descriptor open on the installation lock that the release installer passed down (RIG_INSTALL_LOCK_FD): an install
   * holds the lock through it, so the lock stays held to the end of this run even if the installer dies. */
  inheritedLock?: number;
}

/** Administration effect owner: it observes what runs under the root, decides what an install or uninstall changes, has the
 * install mode's owner act (a detached process, a LaunchAgent, or the boot system jobs), and records the outcome as
 * Activity. Installation never mutates Project data. */
export class DaemonAdmin {
  private readonly activity: AdminActivityJournal;
  private readonly launchctl: LaunchctlRunner;
  private readonly process: DaemonLauncher;
  private readonly launchAgent: DaemonLauncher;
  constructor(private readonly options: DaemonAdminOptions) {
    this.activity =
      options.activity ??
      createAdminActivityJournal({
        root: options.root,
        now: () => new Date().toISOString(),
        id: randomUUID,
      });
    this.launchctl = options.launchctl ?? runLaunchctl;
    // The daemon starts with the login basics from the installing shell plus its own variables, in both login modes.
    const environment = () => daemonEnvironment(options.root, process.env);
    this.process = createDaemonProcess({
      root: options.root,
      command: options.command,
      environment,
    });
    this.launchAgent = createLaunchAgent({
      root: options.root,
      command: options.command,
      userHome: options.userHome,
      uid: options.uid,
      launchctl: this.launchctl,
      environment,
    });
  }
  async status(): Promise<DaemonStatus> {
    return (await observeDaemon(this.options.root)).status;
  }
  async install(operationId?: string): Promise<DaemonStatus> {
    // An unsafe root is refused before anything, Activity included, is written into it.
    await securePrivateRoot(this.options.root);
    return this.recordAdministration("daemon-install", operationId, () =>
      this.exclusively(async () =>
        withToolBunWarning(await this.performInstall(), this.options.bun),
      ),
    );
  }
  async uninstall(operationId?: string): Promise<DaemonStatus> {
    return this.recordAdministration("daemon-uninstall", operationId, () =>
      this.exclusively(() => this.performUninstall()),
    );
  }
  /** Runs `work` holding the installation lock, so one install, upgrade or uninstall changes this Rig root at a time: what
   * one finds running is still so when it acts. The release installer holds it across the rigd install it runs and passes
   * it down; another holder is refused, DAEMON_INSTALL_LOCKED. */
  private async exclusively<T>(work: () => Promise<T>): Promise<T> {
    const lockPath = installLockPath(this.options.root);
    await privateDirectory(this.options.root, dirname(lockPath));
    const acquired =
      (this.options.inheritedLock === undefined
        ? undefined
        : await inheritProcessLock(lockPath, this.options.inheritedLock)) ??
      (await acquireProcessLock(lockPath, { keep: true }));
    if ("lock" in acquired)
      try {
        return await work();
      } finally {
        await acquired.lock.release();
      }
    const { pid } = acquired.held;
    throw new RigError(
      "DAEMON_INSTALL_LOCKED",
      "Another rigd install, upgrade or uninstall is changing this Rig root.",
      `The lock at ${lockPath} is held by ${pid ? `pid ${pid}` : "another process"}, which is still running. Wait for it to finish, then run this command again.`,
      { lockPath, ...(pid ? { pid } : {}) },
    );
  }
  /** The one owner of an administration's outcome: a failure is recorded by its code and rethrown, a result by its outcome,
   * and Activity that cannot be written becomes a warning on the result. */
  private async recordAdministration(
    action: "daemon-install" | "daemon-uninstall",
    operationId: string | undefined,
    work: () => Promise<DaemonStatus>,
  ): Promise<DaemonStatus> {
    let result: DaemonStatus;
    try {
      result = await work();
    } catch (error) {
      await this.activity
        .append({
          id: operationId,
          action,
          outcome: "failed",
          message: error instanceof RigError ? error.code : "UNEXPECTED",
        })
        .catch(() => {});
      throw error;
    }
    const evidence = await this.activity
      .append({ id: operationId, action, outcome: result.outcome! })
      .catch(() => ({
        warning:
          "Daemon activity could not be recorded; the administration outcome is unchanged.",
      }));
    return {
      ...result,
      ...(evidence.warning
        ? { warnings: [...(result.warnings ?? []), evidence.warning] }
        : {}),
    };
  }
  private async performInstall(): Promise<DaemonStatus> {
    const { root } = this.options;
    const {
      status: prior,
      unverified,
      serving,
      credential,
    } = await observeDaemon(root);
    let replaced: DaemonStatus["replaced"];
    // rigd chooses its router as it starts, so a different proxy mode needs a restart, as does a managed Caddy that is not
    // installed the way Host config asks: it is installed only while no rigd publishes.
    const proxyMode = await this.options.proxy?.mode();
    // What Host config alone can refuse is refused while rigd still runs, so a refusal never costs a restart.
    if (proxyMode === "managed") await this.options.proxy!.preflight();
    const start =
      this.options.mode === "launchd"
        ? ((await this.options.start?.()) ?? "login")
        : "login";
    if (start === "boot")
      return installSystemDaemon(
        this.systemInstall(),
        prior,
        serving,
        proxyMode,
      );
    // Back to a LaunchAgent: the system jobs go first, or two rigd would run for one root.
    const leftovers = await systemLeftovers(root, this.places());
    if (leftovers.length) throw systemJobsRemain(leftovers, this.places());
    if (prior.reachable && serving) {
      const recorded = prior.installed
        ? await readInstallation(root)
        : undefined;
      const current =
        recorded !== undefined &&
        recordedAsWanted(recorded, {
          mode: this.options.mode,
          command: this.options.command,
          version: RIG_BUILD,
          bun: this.options.bun,
          proxy: proxyMode,
        }) &&
        serving.version === RIG_BUILD &&
        (await this.servesDashboardAsAsked(serving)) &&
        (proxyMode !== "managed" || (await this.options.proxy!.inSync()));
      if (current) return { ...prior, outcome: "unchanged" };
      if (recorded === undefined) return await this.adopt(prior);
      // Another version or command is serving: stop it and start this one. Managed
      // processes keep serving under their leases and the new daemon adopts them.
      await prepareStop(root);
      await this.stopForReplacement(recorded.mode, serving.pid);
      replaced = {
        pid: serving.pid,
        ...(recorded.version ? { version: recorded.version } : {}),
      };
    }
    if (prior.running && !replaced)
      throw new RigError(
        "DAEMON_UNREACHABLE",
        credential
          ? "A daemon process exists, but its credential is unusable, so it is not reachable and was not replaced."
          : "A daemon process exists but is not reachable.",
        credential
          ? `${credential.message} Restore ${daemonTokenPath(root)} or stop the running rigd (rigd uninstall signals it), then retry rigd install.`
          : (unverified ?? "Inspect the existing daemon before reinstalling."),
        credential ? { credential: credential.details } : undefined,
      );
    // No daemon is running here, so a fresh token strands nothing and retires
    // any credential a dead daemon's stale port may have exposed.
    await issueToken(root);
    // No rigd runs now, so Rig's Caddy is set up (or taken down) with nothing else publishing, before rigd starts.
    // A proxy failure from here on must not leave the Host without rigd: rigd starts anyway, its startup republish fails
    // closed and doctor reports it, and the failure is still this command's outcome.
    let proxyFailure: unknown;
    try {
      if (proxyMode === "managed") await this.options.proxy!.install();
      else await this.options.proxy?.remove();
    } catch (error) {
      proxyFailure = error;
    }
    await writeInstallation(
      root,
      installationRecord({
        mode: this.options.mode,
        command: this.options.command,
        version: RIG_BUILD,
        bun: this.options.bun,
        proxy: proxyMode,
      }),
    );
    await clearStartupFailure(root);
    const launcher = this.launcher(this.options.mode);
    try {
      await launcher.start();
    } catch (error) {
      // A job that never started must not be reported installed or auto-loaded at the next login.
      await rm(installationPath(root), { force: true });
      await launcher.discard();
      throw error;
    }
    return await this.awaitStart(launcher, proxyFailure, replaced);
  }
  /** A daemon serving without its record (deleted by hand, or started manually) is adopted: recording it is what makes
   * uninstall able to stop it. Which bun it read at startup is unknown, so none is recorded and, when this rigd has one, the
   * next install replaces the daemon with one that reads it. */
  private async adopt(prior: DaemonStatus): Promise<DaemonStatus> {
    await writeInstallation(
      this.options.root,
      installationRecord({
        mode: this.options.mode,
        command: this.options.command,
        version: RIG_BUILD,
      }),
    );
    const unknownBun = this.options.bun
      ? [
          `Adopted a running rigd whose bun for source-file Tools is unknown; run rigd install again to restart it with ${this.options.bun}.`,
        ]
      : [];
    const warnings = [...(prior.warnings ?? []), ...unknownBun];
    return {
      ...prior,
      installed: true,
      outcome: "installed",
      ...(warnings.length ? { warnings } : {}),
    };
  }
  /** Waits up to five seconds for the started daemon to answer. One that reports its own failed start is not installed: a
   * launchd job would only relaunch it. */
  private async awaitStart(
    launcher: DaemonLauncher,
    proxyFailure: unknown,
    replaced: DaemonStatus["replaced"],
  ): Promise<DaemonStatus> {
    const { root } = this.options;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await this.status();
      if (status.reachable) {
        if (proxyFailure) throw proxyFailure;
        return {
          ...status,
          outcome: "installed",
          ...(replaced ? { replaced } : {}),
        };
      }
      // The daemon reports its own failed start; waiting longer would not change it.
      const startup = await readStartupFailure(root);
      if (startup) {
        await launcher.abandon();
        await this.removeInstallation(this.options.mode);
        throw new RigError(
          "DAEMON_START",
          `rigd did not start: ${startup.message}`,
          startup.hint ??
            "Inspect the daemon startup log and retry installation.",
          { startup },
        );
      }
      await pause(50);
    }
    throw new RigError(
      "DAEMON_START",
      "rigd did not become reachable.",
      `rigd did not answer within five seconds and recorded no failure. Inspect ${join(root, "daemon", "startup.log")} and retry installation.`,
      { log: join(root, "daemon", "startup.log") },
    );
  }
  /** Stops a serving daemon so a newer one can take its place; a daemon that will not stop keeps its installation. */
  private async stopForReplacement(
    mode: DaemonMode,
    pid: number,
  ): Promise<void> {
    await this.launcher(mode).stop(pid);
    if (!(await stopsWithin(() => processExists(pid), this.stopTimeoutMs())))
      throw new RigError(
        "DAEMON_STOP",
        "The running rigd did not stop, so it was not replaced.",
        `rigd pid ${pid} is still running; inspect it, then run rigd install again to upgrade.`,
        { pid },
      );
  }
  private async performUninstall(): Promise<DaemonStatus> {
    const { root } = this.options;
    const { status, records, unverified } = await observeDaemon(root);
    // Rig's Caddy can outlive the daemon's record (an install whose rigd never started removes only the record), so it is
    // removed whether or not rigd is installed, a system job by the owner's sudo.
    if (!status.installed && !status.running && !status.reachable) {
      if (this.options.mode !== "process") await this.refuseSystemJobs();
      return {
        ...status,
        outcome: (await this.options.proxy?.remove())
          ? "uninstalled"
          : "unchanged",
      };
    }
    const address = await readDaemonAddress(root);
    // Without a record the mode is unknown; the stop below then tries both
    // launchd and the pid, so a daemon is never left that nothing can remove.
    const recorded = status.installed
      ? await readInstallation(root)
      : undefined;
    const mode = recorded?.mode ?? this.options.mode;
    if (!address || !status.reachable) {
      if (unverified)
        throw new RigError(
          "DAEMON_UNCERTAIN",
          "A recorded daemon process is alive but cannot be verified as rigd, so it was not signalled.",
          unverified,
        );
      return await this.removeUnreachable(mode, records);
    }
    const client = new DaemonClient({
      port: address.port,
      token: await readDaemonToken(root),
    });
    // This serialized runtime operation blocks subsequent mutations after verifying zero active Targets.
    const readiness = z
      .object({ ready: z.literal(true) })
      .safeParse(await client.command({ action: "prepare-uninstall" }));
    if (!readiness.success)
      throw new RigError(
        "DAEMON_UNCERTAIN",
        "rigd did not confirm a safe uninstall.",
        "Stop all Targets and retry.",
      );
    // A system job is removed by the owner's sudo; rigd keeps serving until then, and the next uninstall finishes.
    // Whatever the record says: a line pasted without a later rigd install leaves a system job the record does not name.
    if (mode !== "process") {
      const leftovers = await systemLeftovers(root, this.places());
      if (leftovers.length) {
        await client.command({ action: "cancel-uninstall" }).catch(() => {});
        throw systemRemovalRequired(leftovers, this.places());
      }
    }
    try {
      await prepareStop(root, client);
      if (recorded === undefined) {
        await this.launchAgent.abandon();
        if (processExists(address.pid)) await this.process.stop(address.pid);
      } else await this.launcher(mode).stop(address.pid);
      if (
        !(await stopsWithin(
          () => processExists(address.pid),
          this.stopTimeoutMs(),
        ))
      )
        throw new RigError(
          "DAEMON_STOP",
          "rigd did not stop.",
          "Inspect daemon state before retrying.",
        );
    } catch (error) {
      await client.command({ action: "cancel-uninstall" }).catch(() => {});
      throw error;
    }
    // Uninstall leaves no Rig process behind; Caddy's certificates and generations stay for the next install. Caddy goes
    // before the record, so a removal that fails leaves the record a retried uninstall needs to finish it.
    await this.options.proxy?.remove();
    await this.removeInstallation(mode);
    return {
      installed: false,
      running: false,
      reachable: false,
      outcome: "uninstalled",
    };
  }
  /** Managed processes are left running under their leases; the next install adopts them, so an unreachable daemon is not a dead end. */
  private async removeUnreachable(
    mode: DaemonMode,
    records: ProcessRecord[],
  ): Promise<DaemonStatus> {
    if (mode !== "process") await this.refuseSystemJobs();
    // Only a process proven to be the recorded rigd is signalled or waited for.
    const alive = async () => {
      const liveness = await Promise.all(records.map(recordedProcess));
      return records.filter((_, index) => liveness[index] === "running");
    };
    await this.launcher(mode).stopUnreachable(alive);
    if (
      !(await stopsWithin(
        async () => (await alive()).length > 0,
        this.stopTimeoutMs(),
      ))
    )
      throw new RigError(
        "DAEMON_STOP",
        "rigd did not stop.",
        "Inspect daemon state before retrying.",
      );
    await this.options.proxy?.remove();
    await this.removeInstallation(mode);
    return {
      installed: false,
      running: false,
      reachable: false,
      outcome: "uninstalled",
      warnings: [
        "rigd was not reachable, so its Targets could not be verified stopped; any running managed processes keep running and the next rigd install adopts them.",
      ],
    };
  }
  /** Removing a system job left under this root needs the owner's sudo, so an uninstall stops at one. */
  private async refuseSystemJobs(): Promise<void> {
    const leftovers = await systemLeftovers(this.options.root, this.places());
    if (leftovers.length) throw systemRemovalRequired(leftovers, this.places());
  }
  /** Removes what starts the daemon of `mode` again, then its record and credential. */
  private async removeInstallation(mode: DaemonMode): Promise<void> {
    await this.launcher(mode).discard();
    await removeRecordAndToken(this.options.root);
  }
  /** The owner of a login install mode's process: a LaunchAgent's, or a detached process's. A system job's rigd is stopped
   * by its pid, as a process is, and launchd starts its program again. */
  private launcher(mode: DaemonMode): DaemonLauncher {
    return mode === "launchd" ? this.launchAgent : this.process;
  }
  private systemInstall(): SystemInstall {
    const { options } = this;
    return {
      root: options.root,
      command: options.command,
      ...(options.bun !== undefined ? { bun: options.bun } : {}),
      loginMode: options.mode,
      userHome: options.userHome,
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
      ...(options.userName !== undefined ? { userName: options.userName } : {}),
      places: this.places(),
      launchctl: this.launchctl,
      ...(options.proxy ? { proxy: options.proxy } : {}),
      servesDashboardAsAsked: (serving) => this.servesDashboardAsAsked(serving),
    };
  }
  /** Whether the running rigd serves the dashboard where a rigd started now would (none, when it would serve none). */
  private async servesDashboardAsAsked(
    serving: ServingDaemon | undefined,
  ): Promise<boolean> {
    if (!this.options.dashboard) return true;
    return serving?.dashboard === (await this.options.dashboard());
  }
  private places(): SystemPlaces {
    return this.options.systemPlaces ?? DEFAULT_PLACES;
  }
  private stopTimeoutMs(): number {
    return this.options.stopTimeoutMs ?? 5000;
  }
}
/** An install that found no bun still succeeds, since built Tools and Services do not need it, but it says what will fail. */
function withToolBunWarning(
  result: DaemonStatus,
  bun: string | undefined,
): DaemonStatus {
  if (bun !== undefined) return result;
  return {
    ...result,
    warnings: [
      ...(result.warnings ?? []),
      "rigd install found no bun on PATH, so Tools whose bin is a source file (.ts, .js, ...) fail as BUN_NOT_FOUND; run rigd install again from a shell whose PATH finds bun.",
    ],
  };
}
