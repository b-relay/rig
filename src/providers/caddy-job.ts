import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RigError } from "../domain/errors";
import { renderLaunchdPlist } from "../domain/launchd-plist";
import type { ProxyPaths } from "../domain/managed-proxy";
import {
  processExists,
  processStartTime,
  recordedProcess,
} from "../daemon/process-identity";
import type { CaddyAdminClient } from "./caddy-admin";
import type { CaddyJob, CaddyJobState } from "./managed-caddy";

/** Runs launchctl with the given arguments; the default runs /bin/launchctl, a test passes a fake. */
export type LaunchctlCommand = (
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;
export const runLaunchctlCommand: LaunchctlCommand = async (args) => {
  const child = Bun.spawn(["/bin/launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};
/** A Caddy job Rig can install and remove as well as observe and restart. */
export interface InstallableCaddyJob extends CaddyJob {
  /** Defines the job when it is missing or differs, and starts it. Resolves once Caddy answers, or fails at the deadline. */
  install(): Promise<{ changed: boolean }>;
  /** Stops the job and removes its definition. Certificates, generations and custom files stay. */
  remove(): Promise<void>;
  /** Where the job is defined, for messages. */
  readonly description: string;
  /** Whether the job is defined exactly as this Rig would define it, so an install that changes nothing can say so. */
  matches(): Promise<boolean>;
}
/** The label of Rig's Caddy job for one Rig root: the same hash rigd's own label carries. */
export function caddyJobLabel(root: string): string {
  return `com.b-relay.rig-caddy.${Bun.hash(root).toString(16)}`;
}
/** The program of the job: Rig's copy of Caddy running the current generation, behind a guard on the DNS token. Caddy's
 * DNS plugin quotes a token it rejects in its startup error, which goes straight to the job's log, so the guard starts
 * Caddy only when the token file holds exactly one of the forms the plugin accepts (bytes and all: a trailing newline is a
 * rejection too), or does not exist. Otherwise it says why and exits without starting Caddy. `exec` hands Caddy the job's
 * own process, so launchd's signals and pid are Caddy's. */
export function caddyCommand(paths: ProxyPaths): string[] {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const token = quote(paths.token);
  const script = [
    `if [ -e ${token} ]; then`,
    // BSD grep allows no repetition count above 255, so the longest form's 261 bytes are checked by wc.
    `  if [ "$(LC_ALL=C /usr/bin/tr -d '\\n\\r' < ${token} | /usr/bin/wc -c)" -ne "$(/usr/bin/wc -c < ${token})" ] ||`,
    `     [ "$(/usr/bin/wc -c < ${token})" -gt 261 ] ||`,
    `     ! LC_ALL=C /usr/bin/grep -Eq '^([A-Za-z0-9_-]{35,50}|cf(ut|at)_[A-Za-z0-9_-]{32,})$' ${token}; then`,
    `    echo "rig: ${paths.token} holds no well-formed Cloudflare API token, so Caddy was not started; pipe the token to rig proxy token." >&2`,
    "    exit 78",
    "  fi",
    "fi",
    `exec ${quote(paths.binary)} run --config ${quote(paths.entry)} --adapter caddyfile`,
  ].join("\n");
  return ["/bin/sh", "-c", script];
}
function caddyEnvironment(home: string): Record<string, string> {
  return { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `ready` holds or the deadline passes. */
async function until(
  ready: () => Promise<boolean>,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await ready()) return true;
    if (Date.now() >= deadline) return false;
    await pause(200);
  }
}
function startFailure(paths: ProxyPaths, deadlineMs: number): RigError {
  return new RigError(
    "PROXY_START",
    `Rig's Caddy did not answer on ${paths.socket} within ${Math.round(deadlineMs / 1000)} seconds.`,
    `Read the end of ${paths.jobLog} and ${paths.log} for why it did not start, then run rigd install again.`,
    { socket: paths.socket, log: paths.jobLog },
  );
}

/** How launchd reports one job: running with a pid, stopped (not loaded, or loaded with no process), or unknown. */
async function observeLaunchd(
  launchctl: LaunchctlCommand,
  target: string,
): Promise<{ state: CaddyJobState; pid?: number }> {
  const result = await launchctl(["print", target]).catch(() => undefined);
  if (!result) return { state: "unknown" };
  if (result.code !== 0)
    return /could not find|no such process|not find service/i.test(
      result.stderr + result.stdout,
    )
      ? { state: "stopped" }
      : { state: "unknown" };
  const pid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1];
  if (pid) return { state: "running", pid: Number(pid) };
  return /^\s*state = running\s*$/m.test(result.stdout)
    ? { state: "unknown" }
    : { state: "stopped" };
}
/** The plist of Rig's Caddy as a system job that runs as `userName` from boot (`daemon.start: boot`). */
export function caddySystemPlist(options: {
  readonly root: string;
  readonly paths: ProxyPaths;
  readonly userHome: string;
  readonly userName: string;
}): { label: string; plist: string } {
  const label = caddyJobLabel(options.root);
  return {
    label,
    plist: renderLaunchdPlist({
      label,
      programArguments: caddyCommand(options.paths),
      environment: caddyEnvironment(options.userHome),
      workingDirectory: options.root,
      log: options.paths.jobLog,
      keepAlive: "always",
      userName: options.userName,
      groupName: "staff",
    }),
  };
}
/** Rig's Caddy as a system job (`daemon.start: boot`). Defining or removing it needs the owner's sudo, which `rigd install`
 * prints; this job only verifies that, observes it and restarts it. A restart needs no root: Caddy is asked to exit and the
 * job's KeepAlive starts it again. */
export function createSystemCaddyJob(options: {
  readonly root: string;
  readonly paths: ProxyPaths;
  readonly userHome: string;
  readonly userName: string;
  readonly admin: CaddyAdminClient;
  /** Where system plists live; tests pass a temporary directory. */
  readonly daemons?: string;
  readonly launchctl?: LaunchctlCommand;
  readonly deadlineMs?: number;
}): InstallableCaddyJob {
  const launchctl = options.launchctl ?? runLaunchctlCommand;
  const { label, plist } = caddySystemPlist(options);
  const plistPath = join(
    options.daemons ?? "/Library/LaunchDaemons",
    `${label}.plist`,
  );
  const deadlineMs = options.deadlineMs ?? 30_000;
  const observe = () => observeLaunchd(launchctl, `system/${label}`);
  const matches = async () =>
    (await readFile(plistPath, "utf8").catch(() => undefined)) === plist;
  const needsSudo = (message: string) =>
    new RigError(
      "DAEMON_SYSTEM_INSTALL",
      message,
      "Run rigd install, which prints the sudo line for it.",
      { label },
    );
  return {
    description: plistPath,
    matches,
    state: async () => (await observe()).state,
    async restart() {
      const before = await observe();
      await options.admin.stop();
      const restarted = await until(async () => {
        const now = await observe();
        return (
          now.state === "running" &&
          now.pid !== before.pid &&
          (await options.admin.reachable())
        );
      }, deadlineMs);
      if (!restarted) throw startFailure(options.paths, deadlineMs);
    },
    async install() {
      if (!(await matches()) || (await observe()).state !== "running")
        throw needsSudo(
          `Rig's Caddy is not installed as the system job ${label} this Rig defines.`,
        );
      if (!(await until(() => options.admin.reachable(), deadlineMs)))
        throw startFailure(options.paths, deadlineMs);
      return { changed: false };
    },
    async remove() {
      if (
        (await readFile(plistPath, "utf8").catch(() => undefined)) !==
          undefined ||
        (await observe()).state !== "stopped"
      )
        throw needsSudo(
          `Rig's Caddy is still installed as the system job ${label}.`,
        );
    },
  };
}
/** Rig's Caddy as a LaunchAgent in the user's login (`login` mode). launchd keeps it running: `KeepAlive` starts it again
 * whenever it exits, which is also how a restart takes effect. */
export function createLaunchAgentCaddyJob(options: {
  readonly root: string;
  readonly paths: ProxyPaths;
  readonly userHome: string;
  readonly uid: number;
  readonly admin: CaddyAdminClient;
  readonly launchctl?: LaunchctlCommand;
  /** How long a start or restart may take before it is a failure. Includes launchd's 10 s throttle. */
  readonly deadlineMs?: number;
}): InstallableCaddyJob {
  const launchctl = options.launchctl ?? runLaunchctlCommand;
  const label = caddyJobLabel(options.root);
  const domain = `gui/${options.uid}`;
  const plistPath = join(
    options.userHome,
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  );
  const deadlineMs = options.deadlineMs ?? 30_000;
  const plist = renderLaunchdPlist({
    label,
    programArguments: caddyCommand(options.paths),
    environment: caddyEnvironment(options.userHome),
    workingDirectory: options.root,
    log: options.paths.jobLog,
    keepAlive: "always",
  });
  const observe = () => observeLaunchd(launchctl, `${domain}/${label}`);
  return {
    description: plistPath,
    matches: async () =>
      (await readFile(plistPath, "utf8").catch(() => undefined)) === plist,
    state: async () => (await observe()).state,
    async restart() {
      const before = await observe();
      await options.admin.stop();
      const restarted = await until(async () => {
        const now = await observe();
        return (
          now.state === "running" &&
          now.pid !== before.pid &&
          (await options.admin.reachable())
        );
      }, deadlineMs);
      if (!restarted) throw startFailure(options.paths, deadlineMs);
    },
    async install() {
      const existing = await readFile(plistPath, "utf8").catch(() => undefined);
      const loaded = (await observe()).state === "running";
      const changed = existing !== plist || !loaded;
      if (changed) {
        await mkdir(dirname(plistPath), { recursive: true });
        await writeFile(plistPath, plist, { mode: 0o644 });
        await launchctl(["bootout", `${domain}/${label}`]).catch(() => {});
        const result = await launchctl(["bootstrap", domain, plistPath]);
        if (result.code !== 0)
          throw new RigError(
            "LAUNCHD",
            `launchd refused Rig's Caddy job: ${result.stderr.trim().split("\n").at(-1) ?? "no reason given"}`,
            `Inspect ${plistPath} and retry rigd install.`,
            { code: result.code, stderr: result.stderr },
          );
      }
      if (!(await until(() => options.admin.reachable(), deadlineMs)))
        throw startFailure(options.paths, deadlineMs);
      return { changed };
    },
    async remove() {
      await launchctl(["bootout", `${domain}/${label}`]).catch(() => {});
      await rm(plistPath, { force: true });
    },
  };
}

/** Rig's Caddy as a detached process (`process` mode, a Rig root other than the default, used by tests). Nothing restarts it
 * when it exits; `rig doctor` reports it stopped. */
export function createProcessCaddyJob(options: {
  readonly root: string;
  readonly paths: ProxyPaths;
  readonly userHome: string;
  readonly admin: CaddyAdminClient;
  readonly deadlineMs?: number;
}): InstallableCaddyJob {
  const { paths } = options;
  const deadlineMs = options.deadlineMs ?? 30_000;
  async function record(): Promise<
    { pid: number; startedAt?: string } | undefined
  > {
    try {
      return JSON.parse(await readFile(paths.processRecord, "utf8"));
    } catch {
      return undefined;
    }
  }
  async function state(): Promise<CaddyJobState> {
    const recorded = await record();
    if (!recorded) return "stopped";
    const liveness = await recordedProcess(recorded);
    return liveness === "running"
      ? "running"
      : liveness === "unverified"
        ? "unknown"
        : "stopped";
  }
  async function start(): Promise<void> {
    await mkdir(paths.caddy, { recursive: true });
    const log = await open(paths.jobLog, "a", 0o600);
    try {
      const [executable, ...args] = caddyCommand(paths);
      const child = spawn(executable!, args, {
        cwd: options.root,
        env: caddyEnvironment(options.userHome),
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      const startedAt = await processStartTime(child.pid!);
      await writeFile(
        paths.processRecord,
        JSON.stringify({ pid: child.pid, startedAt }) + "\n",
        { mode: 0o600 },
      );
    } finally {
      await log.close();
    }
    if (!(await until(() => options.admin.reachable(), deadlineMs)))
      throw startFailure(paths, deadlineMs);
  }
  async function stop(): Promise<void> {
    const recorded = await record();
    await options.admin.stop();
    if (recorded && (await recordedProcess(recorded)) === "running") {
      const gone = await until(
        async () => !processExists(recorded.pid),
        10_000,
      );
      if (!gone) process.kill(recorded.pid, "SIGKILL");
    }
    await rm(paths.processRecord, { force: true });
  }
  return {
    description: paths.processRecord,
    matches: async () => true,
    state,
    async restart() {
      await stop();
      await start();
    },
    async install() {
      if ((await state()) === "running") return { changed: false };
      await start();
      return { changed: true };
    },
    remove: stop,
  };
}
/** The Caddy job that sits beside rigd: a detached process, a LaunchAgent, or a system job, as rigd itself runs. */
export function createCaddyJob(options: {
  readonly root: string;
  readonly paths: ProxyPaths;
  readonly mode: "process" | "launchd" | "system";
  readonly userHome: string;
  readonly uid: number;
  readonly userName: string;
  readonly admin: CaddyAdminClient;
  readonly launchctl?: LaunchctlCommand;
  readonly deadlineMs?: number;
  /** Where system plists live; tests pass a temporary directory. */
  readonly daemons?: string;
}): InstallableCaddyJob {
  const common = {
    root: options.root,
    paths: options.paths,
    userHome: options.userHome,
    admin: options.admin,
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
  };
  if (options.mode === "process") return createProcessCaddyJob(common);
  const launchctl = options.launchctl ? { launchctl: options.launchctl } : {};
  return options.mode === "system"
    ? createSystemCaddyJob({
        ...common,
        ...launchctl,
        userName: options.userName,
        ...(options.daemons ? { daemons: options.daemons } : {}),
      })
    : createLaunchAgentCaddyJob({ ...common, ...launchctl, uid: options.uid });
}
