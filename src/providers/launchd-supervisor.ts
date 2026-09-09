import { clearCaptureStatus, waitForCaptureStart } from "./capture-status";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RigError } from "../domain/errors";
import type {
  CommandRunner,
  ManagedProcess,
  ProcessObservation,
  Supervisor,
} from "./contracts";
import { runCommand } from "./command-runner";
export interface LaunchdOptions {
  readonly root: string;
  readonly domain: string;
  readonly labelPrefix: string;
  readonly run?: CommandRunner;
  /** rigd's private capture command, used to timestamp and separate both application streams. */
  readonly captureCommand?: readonly string[];
}
/** launchd owns persistent job lifetime; explicit up preserves already running jobs. */
export function createLaunchdSupervisor(options: LaunchdOptions): Supervisor {
  const run = options.run ?? runCommand;
  const label = (key: string) =>
    `${options.labelPrefix}.${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  const service = (key: string) => `${options.domain}/${label(key)}`;
  const checked = async (args: readonly string[]) => {
    const result = await run({ command: ["launchctl", ...args] });
    if (result.exitCode !== 0)
      throw new RigError(
        "LAUNCHD_FAILED",
        "launchd could not complete the requested action.",
        "Check daemon diagnostics and the Target logs.",
        { action: args[0], exitCode: result.exitCode, stderr: result.stderr },
      );
    return result;
  };
  const observe = async (
    key: string,
    signal?: AbortSignal,
  ): Promise<ProcessObservation> => {
    if (signal?.aborted)
      return { state: "unknown", reason: "Observation cancelled." };
    try {
      const result = await run({
        command: ["launchctl", "print", service(key)],
        signal,
        timeoutMs: 2000,
      });
      if (result.exitCode !== 0)
        return /could not find service|service not found/i.test(result.stderr)
          ? { state: "stopped" }
          : { state: "unknown", reason: "launchd could not inspect the job." };
      const pid = result.stdout.match(/^\s*pid = (\d+)\s*$/m);
      if (pid) return { state: "running", pid: Number(pid[1]) };
      const exit = result.stdout.match(/^\s*last exit code = (\d+)\s*$/m);
      return {
        state: "stopped",
        ...(exit ? { exitCode: Number(exit[1]) } : {}),
      };
    } catch {
      return {
        state: "unknown",
        reason: signal?.aborted
          ? "Observation cancelled."
          : "launchd observation failed.",
      };
    }
  };
  return {
    observe,
    async ensureRunning(request) {
      const before = await observe(request.key);
      if (before.state === "running")
        return { outcome: "unchanged", pid: before.pid };
      if (before.state === "unknown")
        throw new RigError(
          "LAUNCHD_UNKNOWN",
          "The existing job could not be inspected.",
          "Resolve launchd access before starting it.",
          { key: request.key },
        );
      await mkdir(options.root, { recursive: true });
      await mkdir(request.logRoot, { recursive: true });
      const jobLabel = label(request.key);
      const requestPath = join(options.root, `${jobLabel}.json`);
      let command = request.command;
      if (options.captureCommand) {
        await clearCaptureStatus(requestPath);
        await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
        command = [...options.captureCommand, requestPath];
      }
      const plist = join(options.root, `${jobLabel}.plist`);
      await writeFile(
        plist,
        launchdPlist(
          {
            ...request,
            command,
            keepAlive: options.captureCommand ? false : request.keepAlive,
          },
          jobLabel,
        ),
        { mode: 0o600 },
      );
      const existing = await run({
        command: ["launchctl", "print", service(request.key)],
        timeoutMs: 2000,
      });
      if (existing.exitCode === 0)
        await checked(["bootout", service(request.key)]);
      await checked(["bootstrap", options.domain, plist]);
      if (options.captureCommand) {
        try {
          await waitForCaptureStart(requestPath);
        } catch (error) {
          await checked(["bootout", service(request.key)]);
          throw error;
        }
      }
      for (let attempt = 0; attempt < 30; attempt++) {
        const observation = await observe(request.key);
        if (observation.state === "running")
          return { outcome: "started", pid: observation.pid };
        await Bun.sleep(100);
      }
      throw new RigError(
        "LAUNCHD_START",
        "The managed job did not start.",
        "Inspect the Target logs and retry.",
        { key: request.key },
      );
    },
    async stop(key) {
      const existing = await run({
        command: ["launchctl", "print", service(key)],
        timeoutMs: 2000,
      });
      if (existing.exitCode !== 0) {
        if (/could not find service|service not found/i.test(existing.stderr))
          return { outcome: "unchanged" };
        throw new RigError(
          "LAUNCHD_UNKNOWN",
          "The existing job could not be inspected.",
          "Resolve launchd access before stopping it.",
          { key },
        );
      }
      await checked(["bootout", service(key)]);
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await run({
          command: ["launchctl", "print", service(key)],
          timeoutMs: 2000,
        });
        if (
          result.exitCode !== 0 &&
          /could not find service|service not found/i.test(result.stderr)
        ) {
          await rm(join(options.root, `${label(key)}.plist`), { force: true });
          await rm(join(options.root, `${label(key)}.json`), { force: true });
          return { outcome: "stopped" };
        }
        await Bun.sleep(100);
      }
      throw new RigError(
        "LAUNCHD_STOP",
        "The managed job did not unload.",
        "Inspect launchd state before retrying.",
        { key },
      );
    },
    async shutdown() {
      /* Persistent jobs remain owned by launchd when the daemon exits. */
    },
  };
}
function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function launchdPlist(request: ManagedProcess, label: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${request.command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(request.cwd)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(
    request.env,
  )
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join(
      "",
    )}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><${request.keepAlive ? "true" : "false"}/>\n<key>StandardOutPath</key><string>${xml(join(request.logRoot, `${request.componentName}.stdout.log`))}</string>\n<key>StandardErrorPath</key><string>${xml(join(request.logRoot, `${request.componentName}.stderr.log`))}</string>\n</dict></plist>\n`;
}
