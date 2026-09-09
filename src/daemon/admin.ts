import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
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
    if (!address) return { installed, running, reachable: false };
    try {
      const health = await new DaemonClient({
        port: address.port,
        token: await readDaemonToken(this.options.root),
      }).health();
      const reachable =
        health.instanceId === address.instanceId &&
        health.pid === address.pid &&
        (!owner ||
          (owner.pid === address.pid &&
            owner.instanceId === address.instanceId));
      return { installed, running, reachable };
    } catch {
      return { installed, running, reachable: false };
    }
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
    const tokenPath = join(root, "auth", "control-plane.token");
    try {
      await readDaemonToken(root);
    } catch {
      await writeFile(tokenPath, randomBytes(32).toString("base64url"), {
        mode: 0o600,
        flag: "wx",
      });
    }
    await chmod(tokenPath, 0o600);
    await writeFile(
      this.marker,
      JSON.stringify({
        mode: this.options.mode,
        command: this.options.command,
      }),
      { mode: 0o600 },
    );
    if (this.options.mode === "process") await this.spawnDetached();
    else await this.installLaunchd();
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
    if (!address || !status.reachable)
      throw new RigError(
        "DAEMON_UNCERTAIN",
        "Cannot verify that rigd and its Targets can be removed safely.",
        "Restore daemon reachability and stop Targets before uninstalling.",
      );
    let savedInstallation: unknown;
    try {
      savedInstallation = JSON.parse(await readFile(this.marker, "utf8"));
    } catch {
      throw new RigError(
        "DAEMON_INSTALL_STATE",
        "The installation record is unreadable.",
        "Inspect the daemon installation before retrying.",
      );
    }
    const installation = z
      .object({ mode: z.enum(["process", "launchd"]) })
      .safeParse(savedInstallation);
    if (!installation.success)
      throw new RigError(
        "DAEMON_INSTALL_STATE",
        "The installation record is invalid.",
        "Inspect the daemon installation before retrying.",
      );
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
    if (installation.data.mode === "launchd")
      await rm(this.plistPath(), { force: true });
    await rm(this.marker, { force: true });
    await rm(join(root, "auth", "control-plane.token"), { force: true });
    return {
      installed: false,
      running: false,
      reachable: false,
      outcome: "uninstalled",
    };
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
    const child = Bun.spawn(["/bin/launchctl", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0)
      throw new RigError(
        "LAUNCHD",
        "Unable to administer the rigd launchd job.",
        "Inspect daemon installation and retry.",
        { code },
      );
  }
  private async installLaunchd(): Promise<void> {
    await mkdir(join(this.options.userHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${xml(this.label())}</string><key>ProgramArguments</key><array>${this.options.command.map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>RIG_ROOT</key><string>${xml(this.options.root)}</string><key>RIG_DAEMON_CHILD</key><string>1</string><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>WorkingDirectory</key><string>${xml(this.options.root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(this.options.root, "daemon", "startup.log"))}</string><key>StandardErrorPath</key><string>${xml(join(this.options.root, "daemon", "startup.log"))}</string></dict></plist>`;
    await writeFile(this.plistPath(), plist, { mode: 0o600 });
    await this.launchctl(["bootout", this.labelDomain()]).catch(() => {});
    await this.launchctl([
      "bootstrap",
      `gui/${this.options.uid ?? process.getuid?.() ?? 501}`,
      this.plistPath(),
    ]);
  }
}
