import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  constants,
  mkdir,
  readFile,
  writeFile,
  rm,
  open,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "./client";
import { readDaemonAddress, readDaemonOwner, readDaemonToken } from "./files";
import { RigError } from "../domain/errors";
import { RIG_VERSION } from "../domain/version";
import { processExists } from "./host";
import { recordedProcess, type ProcessRecord } from "./process-identity";
import { clearStartupFailure, readStartupFailure } from "./startup-failure";
import { inheritedEnvironment } from "./environment";
import { z } from "zod";
import {
  createAdminActivityJournal,
  type AdminActivityJournal,
} from "../adapters/admin-activity";

export interface DaemonAdminOptions {
  root: string;
  command: readonly string[];
  mode: "process" | "launchd";
  userHome: string;
  uid?: number;
  stopTimeoutMs?: number;
  activity?: AdminActivityJournal;
  /** Runs launchctl with the given arguments; defaults to /bin/launchctl. */
  launchctl?: LaunchctlRunner;
}
export type LaunchctlRunner = (
  args: readonly string[],
) => Promise<{ code: number; stderr: string }>;
const installationSchema = z.object({
  mode: z.enum(["process", "launchd"]),
  command: z.array(z.string()).optional(),
  version: z.string().optional(),
});
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
    this.marker = join(options.root, "daemon", "install.json");
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
    const status = (serving?: { pid: number; version?: string }) => {
      // A serving daemon of another version is the one thing `rigd install` can change here.
      const skew =
        serving && serving.version !== RIG_VERSION
          ? [
              `rigd ${serving.version ?? "of an older version"} is serving, but this rigd is ${RIG_VERSION}; run rigd install to upgrade the daemon.`,
            ]
          : [];
      const all = [...warnings, ...skew];
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
    try {
      const health = await new DaemonClient({
        port: address.port,
        token: await readDaemonToken(this.options.root),
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
    mode: "process" | "launchd",
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
  private async writeInstallation(): Promise<void> {
    await mkdir(join(this.options.root, "daemon"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      this.marker,
      JSON.stringify({
        mode: this.options.mode,
        command: this.options.command,
        version: RIG_VERSION,
      }),
      { mode: 0o600 },
    );
  }
  private async readInstallation(): Promise<
    z.infer<typeof installationSchema>
  > {
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(this.marker, "utf8"));
    } catch {
      throw new RigError(
        "DAEMON_INSTALL_STATE",
        "The installation record is unreadable.",
        "Inspect the daemon installation before retrying.",
      );
    }
    const installation = installationSchema.safeParse(saved);
    if (!installation.success)
      throw new RigError(
        "DAEMON_INSTALL_STATE",
        "The installation record is invalid.",
        "Inspect the daemon installation before retrying.",
      );
    return installation.data;
  }
  async install(operationId?: string): Promise<DaemonStatus> {
    return this.recordAdministration("daemon-install", operationId, () =>
      this.performInstall(),
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
      ...(evidence.warning ? { warnings: [evidence.warning] } : {}),
    };
  }
  private async performInstall(): Promise<DaemonStatus> {
    const { status: prior, unverified, serving } = await this.inspect();
    let replaced: DaemonStatus["replaced"];
    if (prior.reachable && serving) {
      const recorded = prior.installed
        ? await this.readInstallation()
        : undefined;
      const current =
        recorded !== undefined &&
        recorded.version === RIG_VERSION &&
        serving.version === RIG_VERSION &&
        (recorded.command ?? []).join("\0") === this.options.command.join("\0");
      if (current) return { ...prior, outcome: "unchanged" };
      if (recorded === undefined) {
        // A daemon serving without its record (deleted by hand, or started manually)
        // is adopted: recording it is what makes uninstall able to stop it.
        await this.writeInstallation();
        return { ...prior, installed: true, outcome: "installed" };
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
        "A daemon process exists but is not reachable.",
        unverified ?? "Inspect the existing daemon before reinstalling.",
      );
    const { root } = this.options;
    await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "daemon"), { recursive: true, mode: 0o700 });
    // No daemon is running here, so a fresh token strands nothing and retires
    // any credential a dead daemon's stale port may have exposed.
    const tokenPath = join(root, "auth", "control-plane.token");
    await writeFile(tokenPath, randomBytes(32).toString("base64url"), {
      mode: 0o600,
    });
    await chmod(tokenPath, 0o600);
    await this.writeInstallation();
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
      if (status.reachable)
        return {
          ...status,
          outcome: "installed",
          ...(replaced ? { replaced } : {}),
        };
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
    return {
      installed: false,
      running: false,
      reachable: false,
      outcome: "uninstalled",
    };
  }
  /** Managed processes are left running under their leases; the next install adopts them, so an unreachable daemon is not a dead end. */
  private async removeUnreachable(
    mode: "process" | "launchd",
    records: ProcessRecord[],
  ): Promise<DaemonStatus> {
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
  private async removeInstallation(mode: "process" | "launchd"): Promise<void> {
    if (mode === "launchd") await rm(this.plistPath(), { force: true });
    await rm(this.marker, { force: true });
    await rm(join(this.options.root, "auth", "control-plane.token"), {
      force: true,
    });
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
