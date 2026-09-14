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
import { processExists } from "./host";
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
    const running = [owner?.pid, address?.pid].some(
      (pid) => pid !== undefined && processExists(pid),
    );
    const warnings = installed ? await this.installationWarnings() : [];
    const status = (reachable: boolean): DaemonStatus => ({
      installed,
      running,
      reachable,
      ...(warnings.length ? { warnings } : {}),
    });
    // Never offer the credential to a port whose recorded owner has exited.
    if (!address || !processExists(address.pid)) return status(false);
    try {
      const health = await new DaemonClient({
        port: address.port,
        token: await readDaemonToken(this.options.root),
      }).health();
      return status(
        health.instanceId === address.instanceId &&
          health.pid === address.pid &&
          (!owner ||
            (owner.pid === address.pid &&
              owner.instanceId === address.instanceId)),
      );
    } catch {
      return status(false);
    }
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
    const prior = await this.status();
    if (prior.reachable) return { ...prior, outcome: "unchanged" };
    if (prior.running)
      throw new RigError(
        "DAEMON_UNREACHABLE",
        "A daemon process exists but is not reachable.",
        "Inspect the existing daemon before reinstalling.",
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
    await writeFile(
      this.marker,
      JSON.stringify({
        mode: this.options.mode,
        command: this.options.command,
      }),
      { mode: 0o600 },
    );
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
      if (status.reachable) return { ...status, outcome: "installed" };
      await pause(50);
    }
    throw new RigError(
      "DAEMON_START",
      "rigd did not become reachable.",
      "Inspect the daemon startup log and retry installation.",
    );
  }
  private async performUninstall(): Promise<DaemonStatus> {
    const { root } = this.options;
    const status = await this.status();
    if (!status.installed && !status.running && !status.reachable)
      return { ...status, outcome: "unchanged" };
    const address = await readDaemonAddress(root);
    const installation = { data: await this.readInstallation() };
    if (!address || !status.reachable)
      return await this.removeUnreachable(installation.data.mode, [
        address?.pid,
        (await readDaemonOwner(root))?.pid,
      ]);
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
      if (installation.data.mode === "launchd")
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
    pids: (number | undefined)[],
  ): Promise<DaemonStatus> {
    if (mode === "launchd") {
      const result = await (this.options.launchctl ?? runLaunchctl)([
        "bootout",
        this.labelDomain(),
      ]);
      if (result.code !== 0 && !/No such process|Could not find/i.test(result.stderr))
        throw launchctlFailure(result);
    } else
      for (const pid of pids)
        if (pid !== undefined && processExists(pid))
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
    const deadline = Date.now() + (this.options.stopTimeoutMs ?? 5000);
    const alive = () =>
      pids.some((pid) => pid !== undefined && processExists(pid));
    while (alive() && Date.now() < deadline) await pause(50);
    if (alive())
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
        env: {
          ...process.env,
          RIG_ROOT: this.options.root,
          RIG_DAEMON_CHILD: "1",
        },
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
  private async launchctl(args: string[]): Promise<void> {
    const result = await (this.options.launchctl ?? runLaunchctl)(args);
    if (result.code !== 0) throw launchctlFailure(result);
  }
  private async installLaunchd(): Promise<void> {
    await mkdir(join(this.options.userHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${xml(this.label())}</string><key>ProgramArguments</key><array>${this.options.command.map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>RIG_ROOT</key><string>${xml(this.options.root)}</string><key>RIG_DAEMON_CHILD</key><string>1</string><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>WorkingDirectory</key><string>${xml(this.options.root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(this.options.root, "daemon", "startup.log"))}</string><key>StandardErrorPath</key><string>${xml(join(this.options.root, "daemon", "startup.log"))}</string></dict></plist>`;
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
