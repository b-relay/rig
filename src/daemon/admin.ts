import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  readFile,
  constants,
  mkdir,
  rename,
  writeFile,
  rm,
  open,
  chmod,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { DaemonClient } from "./client";
import {
  daemonTokenPath,
  readDaemonAddress,
  readDaemonOwner,
  readDaemonToken,
} from "./files";
import { RigError } from "../domain/errors";
import { RIG_BUILD } from "../domain/version";
import { processExists } from "./host";
import { recordedProcess, type ProcessRecord } from "./process-identity";
import { clearStartupFailure, readStartupFailure } from "./startup-failure";
import { inheritedEnvironment } from "./environment";
import {
  installationPath,
  readInstallationRecord,
  type DaemonMode,
  type InstallationRecord,
} from "./installation";
import type { ProxyMode } from "../config/proxy-schema";
import type { ProxyInstallation } from "./proxy-installation";
import { renderLaunchdPlist } from "../domain/launchd-plist";
import {
  DEFAULT_PLACES,
  systemInstallLine,
  systemRemoveLine,
  type SystemJob,
  type SystemPlaces,
} from "../domain/system-install";
import { caddyJobLabel } from "../providers/caddy-job";
import { userInfo } from "node:os";
import { z } from "zod";
import {
  createAdminActivityJournal,
  type AdminActivityJournal,
} from "../adapters/admin-activity";

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
  /** The account system jobs run as: the installing user. */
  userName?: string;
  /** Where system plists are staged and installed; tests pass temporary directories. */
  systemPlaces?: SystemPlaces;
}
export type LaunchctlRunner = (
  args: readonly string[],
) => Promise<{ code: number; stderr: string }>;
async function runLaunchctl(
  args: readonly string[],
): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn(["/bin/launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stderr };
}
export interface DaemonStatus {
  installed: boolean;
  running: boolean;
  reachable: boolean;
  outcome?: "installed" | "uninstalled" | "unchanged";
  /** The version the reachable daemon reports; absent when unreachable or older than version reporting. */
  version?: string;
  /** The daemon this install stopped and replaced, when it was of another version or command. */
  replaced?: { pid: number; version?: string };
  warnings?: string[];
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Administration effect owner. Installation never mutates Project data. */
export class DaemonAdmin {
  private readonly marker: string;
  private readonly activity: AdminActivityJournal;
  constructor(private readonly options: DaemonAdminOptions) {
    this.marker = installationPath(options.root);
    this.activity =
      options.activity ??
      createAdminActivityJournal({
        root: options.root,
        now: () => new Date().toISOString(),
        id: randomUUID,
      });
  }
  async status(): Promise<DaemonStatus> {
    return (await this.inspect()).status;
  }
  /** Status plus what a caller acting on it needs: the ownership records and
   * the hint for records whose pid is alive but cannot be verified as rigd. */
  private async inspect(): Promise<{
    status: DaemonStatus;
    records: ProcessRecord[];
    unverified?: string;
    /** The reachable daemon's pid and reported version, for an install deciding whether to replace it. */
    serving?: { pid: number; version?: string };
    /** Why the recorded daemon could not be contacted: its credential is empty or unreadable. */
    credential?: RigError;
  }> {
    let installed = true;
    try {
      await access(this.marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new RigError(
          "DAEMON_INSTALL_STATE",
          "Cannot read the daemon installation record.",
          "Inspect daemon installation permissions.",
        );
      installed = false;
    }
    const address = await readDaemonAddress(this.options.root);
    const owner = await readDaemonOwner(this.options.root);
    const records = [owner, address].filter(
      (record): record is NonNullable<typeof record> => record !== undefined,
    );
    // A pid alone is not identity: after a crash it may belong to any process.
    const liveness = await Promise.all(records.map(recordedProcess));
    const running = liveness.some(
      (state) => state === "running" || state === "unverified",
    );
    const unverified = liveness.includes("unverified")
      ? this.unverifiedHint(
          records.filter((_, index) => liveness[index] === "unverified"),
        )
      : undefined;
    const warnings = [
      ...(installed ? await this.installationWarnings() : []),
      ...(unverified ? [unverified] : []),
    ];
    const status = (
      serving?: { pid: number; version?: string },
      credential?: RigError,
    ) => {
      // A serving daemon of another version is the one thing `rigd install` can change here.
      const skew =
        serving && serving.version !== RIG_BUILD
          ? [
              `rigd ${serving.version ?? "of an older version"} is serving, but this rigd is ${RIG_BUILD}; run rigd install to upgrade the daemon.`,
            ]
          : [];
      const all = [
        ...warnings,
        ...skew,
        ...(credential ? [`${credential.message} ${credential.hint}`] : []),
      ];
      return {
        status: {
          installed,
          running,
          reachable: serving !== undefined,
          ...(serving?.version ? { version: serving.version } : {}),
          ...(all.length ? { warnings: all } : {}),
        },
        records,
        ...(unverified ? { unverified } : {}),
        ...(serving ? { serving } : {}),
        ...(credential ? { credential } : {}),
      };
    };
    // Never offer the credential to a port whose recorded owner has exited or been replaced.
    const addressLiveness = address
      ? liveness[records.indexOf(address)]
      : "exited";
    if (
      !address ||
      addressLiveness === "exited" ||
      addressLiveness === "replaced"
    )
      return status();
    let token: string;
    try {
      token = await readDaemonToken(this.options.root);
    } catch (error) {
      if (error instanceof RigError && error.code === "DAEMON_TOKEN")
        return status(undefined, error);
      return status();
    }
    try {
      const health = await new DaemonClient({
        port: address.port,
        token,
      }).health();
      const ours =
        health.instanceId === address.instanceId &&
        health.pid === address.pid &&
        (!owner ||
          (owner.pid === address.pid &&
            owner.instanceId === address.instanceId));
      return status(
        ours
          ? {
              pid: health.pid,
              ...(health.version ? { version: health.version } : {}),
            }
          : undefined,
      );
    } catch {
      return status();
    }
  }
  /** The escape hatch for a live pid that an older rigd recorded without identity. */
  private unverifiedHint(records: ProcessRecord[]): string {
    const files = [
      join(this.options.root, "daemon", "owner.json"),
      join(this.options.root, "daemon", "address.json"),
    ];
    const pids = [...new Set(records.map((record) => record.pid))].join(", ");
    return `The recorded daemon pid ${pids} is alive but was recorded by an older rigd without process identity, so it cannot be verified as rigd. If no rigd is running for this root, remove ${files.join(" and ")} and retry.`;
  }
  /** A recorded program that no longer exists explains an unreachable daemon before anyone reads launchd logs. */
  private async installationWarnings(): Promise<string[]> {
    const installation = await this.readInstallation().catch(() => undefined);
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
  /** Stops a serving daemon so a newer one can take its place; a daemon that will not stop keeps its installation. */
  private async stopForReplacement(
    mode: DaemonMode,
    pid: number,
  ): Promise<void> {
    if (mode === "launchd")
      await this.launchctl(["bootout", this.labelDomain()]);
    else process.kill(pid, "SIGTERM");
    const deadline = Date.now() + (this.options.stopTimeoutMs ?? 5000);
    while (processExists(pid) && Date.now() < deadline) await pause(50);
    if (processExists(pid))
      throw new RigError(
        "DAEMON_STOP",
        "The running rigd did not stop, so it was not replaced.",
        `rigd pid ${pid} is still running; inspect it, then run rigd install again to upgrade.`,
        { pid },
      );
  }
  /** `bun` is what the daemon about to start will read; a daemon already running read its own at startup. The record is
   * written whole, through a sibling temp file and rename, because a starting daemon reads it. */
  private async writeInstallation(
    bun: string | undefined,
    proxy?: ProxyMode,
    mode: DaemonMode = this.options.mode,
  ): Promise<void> {
    await mkdir(join(this.options.root, "daemon"), {
      recursive: true,
      mode: 0o700,
    });
    const record: InstallationRecord = {
      mode,
      command: [...this.options.command],
      version: RIG_BUILD,
      ...(bun ? { bun } : {}),
      ...(proxy ? { proxy } : {}),
    };
    const temporary = `${this.marker}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, this.marker);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  /** Called only once the record is known to exist, so an absent one is as unreadable as a torn one. */
  private async readInstallation(): Promise<InstallationRecord> {
    const installation = await readInstallationRecord(this.options.root);
    if (!installation)
      throw new RigError(
        "DAEMON_INSTALL_STATE",
        "The installation record is unreadable.",
        "Inspect the daemon installation before retrying.",
        { path: this.marker },
      );
    return installation;
  }
  async install(operationId?: string): Promise<DaemonStatus> {
    return this.recordAdministration("daemon-install", operationId, async () =>
      withToolBunWarning(await this.performInstall(), this.options.bun),
    );
  }
  async uninstall(operationId?: string): Promise<DaemonStatus> {
    return this.recordAdministration("daemon-uninstall", operationId, () =>
      this.performUninstall(),
    );
  }
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
    const {
      status: prior,
      unverified,
      serving,
      credential,
    } = await this.inspect();
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
      return this.performSystemInstall(prior, serving, proxyMode);
    // Back to a LaunchAgent: the system jobs go first, or two rigd would run for one root.
    const leftovers = await this.systemLeftovers();
    if (leftovers.length)
      throw new RigError(
        "DAEMON_SYSTEM_INSTALL",
        `rigd is still installed as a system job (${leftovers.join(", ")}), but Host config asks for daemon.start: login.`,
        `Paste ${leftovers.length === 1 ? "this line" : "each of these lines"} in a terminal, then run rigd install again:\n${leftovers.map((label) => systemRemoveLine(label, this.places())).join("\n")}`,
        { labels: leftovers },
      );
    if (prior.reachable && serving) {
      const recorded = prior.installed
        ? await this.readInstallation()
        : undefined;
      // The daemon reads the recorded bun at startup, so a different one needs a restart to take effect.
      const current =
        recorded !== undefined &&
        recorded.version === RIG_BUILD &&
        serving.version === RIG_BUILD &&
        (recorded.command ?? []).join("\0") ===
          this.options.command.join("\0") &&
        recorded.bun === this.options.bun &&
        recorded.mode === this.options.mode &&
        (recorded.proxy ?? "external") === (proxyMode ?? "external") &&
        (proxyMode !== "managed" || (await this.options.proxy!.inSync()));
      if (current) return { ...prior, outcome: "unchanged" };
      if (recorded === undefined) {
        // A daemon serving without its record (deleted by hand, or started manually)
        // is adopted: recording it is what makes uninstall able to stop it. Which bun it
        // read at startup is unknown, so none is recorded and, when this rigd has one, the
        // next install replaces the daemon with one that reads it.
        await this.writeInstallation(undefined);
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
      // Another version or command is serving: stop it and start this one. Managed
      // processes keep serving under their leases and the new daemon adopts them.
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
          ? `${credential.message} Restore ${daemonTokenPath(this.options.root)} or stop the running rigd (rigd uninstall signals it), then retry rigd install.`
          : (unverified ?? "Inspect the existing daemon before reinstalling."),
        credential ? { credential: credential.details } : undefined,
      );
    const { root } = this.options;
    await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "daemon"), { recursive: true, mode: 0o700 });
    // No daemon is running here, so a fresh token strands nothing and retires
    // any credential a dead daemon's stale port may have exposed.
    await this.issueToken();
    // No rigd runs now, so Rig's Caddy is set up (or taken down) with nothing else publishing, before rigd starts.
    // A proxy failure from here on must not leave the Host without rigd: rigd starts anyway, its startup republish fails
    // closed and doctor reports it, and the failure is still this command's outcome.
    let proxyWarnings: string[] = [];
    let proxyFailure: unknown;
    try {
      if (proxyMode === "managed")
        proxyWarnings = await this.options.proxy!.install();
      else await this.options.proxy?.remove();
    } catch (error) {
      proxyFailure = error;
    }
    await this.writeInstallation(this.options.bun, proxyMode);
    await clearStartupFailure(root);
    try {
      if (this.options.mode === "process") await this.spawnDetached();
      else await this.installLaunchd();
    } catch (error) {
      // A job that never started must not be reported installed or auto-loaded at the next login.
      await rm(this.marker, { force: true });
      if (this.options.mode === "launchd")
        await rm(this.plistPath(), { force: true });
      throw error;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await this.status();
      if (status.reachable) {
        if (proxyFailure) throw proxyFailure;
        const warnings = [...(status.warnings ?? []), ...proxyWarnings];
        return {
          ...status,
          outcome: "installed",
          ...(replaced ? { replaced } : {}),
          ...(warnings.length ? { warnings } : {}),
        };
      }
      // The daemon reports its own failed start; waiting longer would not change it.
      const startup = await readStartupFailure(root);
      if (startup) {
        // A daemon that refused to start is not installed; a launchd job would only relaunch it.
        if (this.options.mode === "launchd")
          await this.launchctl(["bootout", this.labelDomain()]).catch(() => {});
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
  private places(): SystemPlaces {
    return this.options.systemPlaces ?? DEFAULT_PLACES;
  }
  private userName(): string {
    return this.options.userName ?? userInfo().username;
  }
  /** The environment of the rigd system job. It is fixed rather than copied from the installing shell, whose PATH changes
   * from one shell to the next: a root-owned plist that differed on every install would ask for sudo every time. */
  private systemEnvironment(): Record<string, string> {
    const home = this.options.userHome;
    return {
      HOME: home,
      USER: this.userName(),
      LOGNAME: this.userName(),
      LANG: "en_US.UTF-8",
      PATH: [
        join(this.options.root, "bin"),
        join(home, ".bun", "bin"),
        join(home, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
      RIG_ROOT: this.options.root,
      RIG_DAEMON_CHILD: "1",
      // The record names the mode only once both jobs are installed; launchd's rigd knows its own from here.
      RIG_DAEMON_MODE: "system",
    };
  }
  /** The system jobs Host config asks for, Caddy first: each replaces the LaunchAgent of the same label, removed only once its
   * system plist is verified. Their plists are rendered under the Rig root, where the printed sudo line copies them from. */
  private async systemJobs(
    proxyMode: ProxyMode | undefined,
  ): Promise<SystemJob[]> {
    const rendered = join(this.options.root, "daemon", "launchd");
    await mkdir(rendered, { recursive: true, mode: 0o700 });
    const agents = join(this.options.userHome, "Library", "LaunchAgents");
    const domain = `gui/${this.options.uid ?? process.getuid?.() ?? 501}`;
    const jobs: { label: string; plist: string }[] = [];
    if (proxyMode === "managed") jobs.push(this.options.proxy!.systemJob());
    jobs.push({
      label: this.label(),
      plist: renderLaunchdPlist({
        label: this.label(),
        programArguments: this.options.command,
        environment: this.systemEnvironment(),
        workingDirectory: this.options.root,
        log: join(this.options.root, "daemon", "startup.log"),
        keepAlive: "always",
        userName: this.userName(),
        groupName: "staff",
      }),
    });
    const result: SystemJob[] = [];
    for (const job of jobs) {
      const source = join(rendered, `${job.label}.plist`);
      await writeFile(source, job.plist, { mode: 0o644 });
      result.push({
        ...job,
        source,
        replaces: { domain, plist: join(agents, `${job.label}.plist`) },
      });
    }
    return result;
  }
  /** A system job is installed when /Library/LaunchDaemons holds exactly the plist this Rig renders and launchd has it. */
  private async systemJobInstalled(job: SystemJob): Promise<boolean> {
    const installed = await readFile(
      join(this.places().daemons, `${job.label}.plist`),
      "utf8",
    ).catch(() => undefined);
    if (installed !== job.plist) return false;
    const result = await (this.options.launchctl ?? runLaunchctl)([
      "print",
      `system/${job.label}`,
    ]).catch(() => ({ code: 1, stderr: "" }));
    return result.code === 0;
  }
  /** Removing system jobs needs the owner's sudo: the error carries one gated line per job. */
  private systemRemovalRequired(labels: readonly string[]): RigError {
    const lines = labels.map((label) => systemRemoveLine(label, this.places()));
    return new RigError(
      "DAEMON_SYSTEM_UNINSTALL",
      `${labels.join(" and ")} ${labels.length === 1 ? "is a system job" : "are system jobs"}, which only root can remove.`,
      `Removing rigd's job stops rigd, so stop every Target first (rig down). Then paste ${lines.length === 1 ? "this line" : "each of these lines"} in a terminal, and run the same rigd command again:\n${lines.join("\n")}`,
      { commands: lines },
    );
  }
  /** The labels of this root's system jobs whose plists are still installed. */
  private async systemLeftovers(): Promise<string[]> {
    const labels = [this.label(), caddyJobLabel(this.options.root)];
    const present: string[] = [];
    for (const label of labels)
      if (
        await access(join(this.places().daemons, `${label}.plist`)).then(
          () => true,
          () => false,
        )
      )
        present.push(label);
    return present;
  }
  /** `daemon.start: boot` (ADR 0014, #287): rigd and its Caddy as system jobs that run as the user from boot. Defining them
   * needs the owner's sudo once, which this prints as one gated line per job; everything else, upgrades included, needs
   * none, because launchd starts each program again from the same path when it exits. */
  private async performSystemInstall(
    prior: DaemonStatus,
    serving: { pid: number; version?: string } | undefined,
    proxyMode: ProxyMode | undefined,
  ): Promise<DaemonStatus> {
    const { root } = this.options;
    // Run with sudo, the jobs would be defined for root.
    if (process.getuid?.() === 0)
      throw new RigError(
        "DAEMON_SYSTEM_INSTALL",
        "rigd install must not run as root.",
        "Run rigd install as the user the jobs should run as; it prints the sudo lines it needs.",
      );
    await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "daemon"), { recursive: true, mode: 0o700 });
    const recorded = prior.installed
      ? await this.readInstallation().catch(() => undefined)
      : undefined;
    const jobs = await this.systemJobs(proxyMode);
    const pending: SystemJob[] = [];
    for (const job of jobs)
      if (!(await this.systemJobInstalled(job))) pending.push(job);
    // A system Caddy left from a proxy section since removed would keep the ports; only root can remove it.
    const caddyLabel = caddyJobLabel(root);
    const staleCaddy =
      proxyMode !== "managed" &&
      (await this.systemLeftovers()).includes(caddyLabel);
    if (pending.length || staleCaddy) {
      // A daemon that runs keeps its credential; with none running, a fresh one is ready for the system rigd.
      if (!prior.running) await this.issueToken();
      // Caddy needs a generation before launchd first starts it; a rigd already publishing through it has one.
      if (
        proxyMode === "managed" &&
        !(prior.reachable && recorded?.proxy === "managed")
      )
        await this.options.proxy!.install({ defineJob: false });
      // The record keeps naming the rigd that runs now until both jobs are installed: a line never pasted must not leave a
      // LaunchAgent rigd recorded as a system job. The system rigd learns its mode from its plist (RIG_DAEMON_MODE).
      await this.writeInstallation(
        this.options.bun,
        proxyMode,
        recorded?.mode === "system" ? "system" : this.options.mode,
      );
      // Created by the user, so launchd appends to files the user owns.
      for (const log of [
        join(root, "daemon", "startup.log"),
        join(root, "caddy", "launchd.log"),
      ]) {
        await mkdir(dirname(log), { recursive: true });
        await writeFile(log, "", { flag: "a", mode: 0o600 });
      }
      const lines = [
        ...(staleCaddy ? [systemRemoveLine(caddyLabel, this.places())] : []),
        ...pending.map((job) => systemInstallLine(job, this.places())),
      ];
      throw new RigError(
        "DAEMON_SYSTEM_INSTALL",
        pending.length
          ? `${pending.map((job) => job.label).join(" and ")} must be installed as system ${pending.length === 1 ? "job" : "jobs"} that run as ${this.userName()} from boot, which needs sudo once.`
          : `Rig's Caddy is still installed as the system job ${caddyLabel}, but Host config has no proxy section.`,
        `Paste ${lines.length === 1 ? "this line" : "each of these lines"} in a terminal, then run rigd install again. Each line stops at the first failure, and checks a plist's digest before anything is installed:\n${lines.join("\n")}`,
        { commands: lines },
      );
    }
    // Both jobs are installed and loaded, so launchd runs them; bringing them up to date needs no root.
    const current =
      prior.reachable &&
      recorded?.mode === "system" &&
      recorded.version === RIG_BUILD &&
      serving?.version === RIG_BUILD &&
      (recorded.command ?? []).join("\0") === this.options.command.join("\0") &&
      recorded.bun === this.options.bun &&
      (recorded.proxy ?? "external") === (proxyMode ?? "external");
    await this.writeInstallation(this.options.bun, proxyMode, "system");
    let replaced: DaemonStatus["replaced"];
    if (!current) {
      // A failure recorded by an earlier start is not this one's.
      await clearStartupFailure(root);
      // launchd starts rigd again from the same path, which is now this build; Services keep running and it adopts them.
      if (prior.reachable && serving) {
        process.kill(serving.pid, "SIGTERM");
        replaced = {
          pid: serving.pid,
          ...(recorded?.version ? { version: recorded.version } : {}),
        };
      }
      await this.awaitSystemDaemon(serving?.pid);
    }
    let warnings: string[] = [];
    if (proxyMode === "managed") {
      const address = await readDaemonAddress(root);
      const client = new DaemonClient({
        port: address!.port,
        token: await readDaemonToken(root),
      });
      warnings = await this.options.proxy!.install({
        publish: () => client.command({ action: "proxy-apply" }),
      });
    }
    const status = await this.status();
    // An upgrade needs no sudo only while the job's program stays at one path.
    const stable = join(root, "bin", "rigd");
    const allWarnings = [
      ...(status.warnings ?? []),
      ...warnings,
      ...(this.options.command[0] !== stable
        ? [
            `The rigd system job runs ${this.options.command[0]}, not ${stable}; installing a rigd from another path asks for sudo again.`,
          ]
        : []),
    ];
    return {
      ...status,
      outcome: current ? "unchanged" : "installed",
      ...(replaced ? { replaced } : {}),
      ...(allWarnings.length ? { warnings: allWarnings } : {}),
    };
  }
  /** Waits for launchd's rigd: a reachable daemon that is not `previous`. The 30 s include launchd's 10 s throttle. */
  private async awaitSystemDaemon(previous: number | undefined): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { status, serving } = await this.inspect();
      if (status.reachable && serving && serving.pid !== previous) return;
      const startup = await readStartupFailure(this.options.root);
      if (startup)
        throw new RigError(
          "DAEMON_START",
          `rigd did not start: ${startup.message}`,
          startup.hint ?? "Inspect the daemon startup log and retry.",
          { startup },
        );
      await pause(100);
    }
    throw new RigError(
      "DAEMON_START",
      "launchd did not bring rigd up within 30 seconds.",
      `Inspect ${join(this.options.root, "daemon", "startup.log")} and launchctl print system/${this.label()}, then retry rigd install.`,
      { log: join(this.options.root, "daemon", "startup.log") },
    );
  }
  private async performUninstall(): Promise<DaemonStatus> {
    const { root } = this.options;
    const { status, records, unverified } = await this.inspect();
    if (!status.installed && !status.running && !status.reachable)
      return { ...status, outcome: "unchanged" };
    const address = await readDaemonAddress(root);
    // Without a record the mode is unknown; the stop below then tries both
    // launchd and the pid, so a daemon is never left that nothing can remove.
    const installation = {
      data: status.installed
        ? await this.readInstallation()
        : {
            mode: this.options.mode,
            command: this.options.command,
            assumed: true,
          },
    };
    if (!address || !status.reachable) {
      if (unverified)
        throw new RigError(
          "DAEMON_UNCERTAIN",
          "A recorded daemon process is alive but cannot be verified as rigd, so it was not signalled.",
          unverified,
        );
      return await this.removeUnreachable(installation.data.mode, records);
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
    if (installation.data.mode !== "process") {
      const leftovers = await this.systemLeftovers();
      if (leftovers.length) {
        await client.command({ action: "cancel-uninstall" }).catch(() => {});
        throw this.systemRemovalRequired(leftovers);
      }
    }
    try {
      if ("assumed" in installation.data) {
        await this.launchctl(["bootout", this.labelDomain()]).catch(() => {});
        if (processExists(address.pid)) process.kill(address.pid, "SIGTERM");
      } else if (installation.data.mode === "launchd")
        await this.launchctl(["bootout", this.labelDomain()]);
      else process.kill(address.pid, "SIGTERM");
      const deadline = Date.now() + (this.options.stopTimeoutMs ?? 5000);
      while (processExists(address.pid) && Date.now() < deadline)
        await pause(50);
      if (processExists(address.pid))
        throw new RigError(
          "DAEMON_STOP",
          "rigd did not stop.",
          "Inspect daemon state before retrying.",
        );
    } catch (error) {
      await client.command({ action: "cancel-uninstall" }).catch(() => {});
      throw error;
    }
    await this.removeInstallation(installation.data.mode);
    // Uninstall leaves no Rig process behind; Caddy's certificates, generations and custom files stay for the next install.
    await this.options.proxy?.remove();
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
    if (mode !== "process") {
      const leftovers = await this.systemLeftovers();
      if (leftovers.length) throw this.systemRemovalRequired(leftovers);
    }
    // Only a process proven to be the recorded rigd is signalled or waited for.
    const alive = async () => {
      const liveness = await Promise.all(records.map(recordedProcess));
      return records.filter((_, index) => liveness[index] === "running");
    };
    if (mode === "launchd") {
      const result = await (this.options.launchctl ?? runLaunchctl)([
        "bootout",
        this.labelDomain(),
      ]);
      if (
        result.code !== 0 &&
        !/No such process|Could not find/i.test(result.stderr)
      )
        throw launchctlFailure(result);
    } else
      for (const { pid } of await alive())
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
    const deadline = Date.now() + (this.options.stopTimeoutMs ?? 5000);
    while ((await alive()).length && Date.now() < deadline) await pause(50);
    if ((await alive()).length)
      throw new RigError(
        "DAEMON_STOP",
        "rigd did not stop.",
        "Inspect daemon state before retrying.",
      );
    await this.removeInstallation(mode);
    await this.options.proxy?.remove();
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
  /** A credential that cannot be written is named by path; a raw fs error would send the user to the diagnostic log. */
  private async issueToken(): Promise<void> {
    const tokenPath = daemonTokenPath(this.options.root);
    try {
      await writeFile(tokenPath, randomBytes(32).toString("base64url"), {
        mode: 0o600,
      });
      await chmod(tokenPath, 0o600);
    } catch (error) {
      const cause = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      throw new RigError(
        "DAEMON_TOKEN",
        `The daemon credential at ${tokenPath} cannot be written (${cause}).`,
        `Make ${tokenPath} and its directory writable by you, then retry rigd install.`,
        { path: tokenPath, cause },
      );
    }
  }
  private async removeInstallation(mode: DaemonMode): Promise<void> {
    if (mode === "launchd") await rm(this.plistPath(), { force: true });
    await rm(this.marker, { force: true });
    await rm(daemonTokenPath(this.options.root), { force: true });
  }
  private async spawnDetached(): Promise<void> {
    const [executable, ...args] = this.options.command;
    if (!executable)
      throw new RigError(
        "DAEMON_COMMAND",
        "No daemon executable is configured.",
        "Build rigd first.",
      );
    const log = await open(
      join(this.options.root, "daemon", "startup.log"),
      "a",
      0o600,
    );
    try {
      const child = spawn(executable, args, {
        cwd: this.options.root,
        env: this.daemonEnvironment(),
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
  }
  private label(): string {
    return `com.b-relay.rigd.${Bun.hash(this.options.root).toString(16)}`;
  }
  private labelDomain(): string {
    return `gui/${this.options.uid ?? process.getuid?.() ?? 501}/${this.label()}`;
  }
  private plistPath(): string {
    return join(
      this.options.userHome,
      "Library",
      "LaunchAgents",
      `${this.label()}.plist`,
    );
  }
  /** The daemon starts with the login basics from the installing shell plus its own variables, in both install modes. */
  private daemonEnvironment(): Record<string, string> {
    return {
      PATH: "/usr/bin:/bin",
      ...inheritedEnvironment(process.env),
      RIG_ROOT: this.options.root,
      RIG_DAEMON_CHILD: "1",
    };
  }
  private async launchctl(args: string[]): Promise<void> {
    const result = await (this.options.launchctl ?? runLaunchctl)(args);
    if (result.code !== 0) throw launchctlFailure(result);
  }
  private async installLaunchd(): Promise<void> {
    await mkdir(join(this.options.userHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${xml(this.label())}</string><key>ProgramArguments</key><array>${this.options.command.map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict>${Object.entries(
      this.daemonEnvironment(),
    )
      .map(
        ([name, value]) =>
          `<key>${xml(name)}</key><string>${xml(value)}</string>`,
      )
      .join(
        "",
      )}</dict><key>WorkingDirectory</key><string>${xml(this.options.root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(this.options.root, "daemon", "startup.log"))}</string><key>StandardErrorPath</key><string>${xml(join(this.options.root, "daemon", "startup.log"))}</string></dict></plist>`;
    await writeFile(this.plistPath(), plist, { mode: 0o600 });
    await this.launchctl(["bootout", this.labelDomain()]).catch(() => {});
    await this.launchctl([
      "bootstrap",
      `gui/${this.options.uid ?? process.getuid?.() ?? 501}`,
      this.plistPath(),
    ]);
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
function launchctlFailure(result: { code: number; stderr: string }): RigError {
  const reason = result.stderr.trim().split("\n").filter(Boolean).at(-1);
  return new RigError(
    "LAUNCHD",
    reason
      ? `Unable to administer the rigd launchd job: ${reason}`
      : "Unable to administer the rigd launchd job.",
    "Inspect daemon installation and retry.",
    { code: result.code, stderr: result.stderr },
  );
}
