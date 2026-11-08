import { access, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  appendPrivateFile,
  privateDirectory,
  replacePrivateFile,
} from "../providers/private-files";
import { RigError } from "../domain/errors";
import { RIG_BUILD } from "../domain/version";
import { renderLaunchdPlist } from "../domain/launchd-plist";
import {
  systemInstallLine,
  systemRemoveLine,
  type SystemJob,
  type SystemPlaces,
} from "../domain/system-install";
import { caddyJobLabel } from "../providers/caddy-job";
import type { ProxyMode } from "../config/proxy-schema";
import { DaemonClient } from "./client";
import { readDaemonAddress, readDaemonToken } from "./files";
import { clearStartupFailure, readStartupFailure } from "./startup-failure";
import type { DaemonMode } from "./installation";
import type { ProxyInstallation } from "./proxy-installation";
import {
  observeDaemon,
  type DaemonStatus,
  type ServingDaemon,
} from "./admin-observation";
import {
  installationRecord,
  issueToken,
  readInstallation,
  writeInstallation,
} from "./admin-records";
import { recordedAsWanted } from "./admin-replacement";
import { rigdJobLabel, type LaunchctlRunner } from "./admin-launch-agent";
import { pause, prepareStop } from "./admin-stop";

/** What a boot install (`daemon.start: boot`) installs and with which capabilities. */
export interface SystemInstall {
  readonly root: string;
  readonly command: readonly string[];
  readonly bun?: string;
  /** The mode the record keeps naming until both jobs are installed: the login install this rigd would otherwise make. */
  readonly loginMode: DaemonMode;
  readonly userHome: string;
  readonly uid?: number;
  /** The account the jobs run as; the current user when absent. */
  readonly userName?: string;
  readonly places: SystemPlaces;
  readonly launchctl: LaunchctlRunner;
  readonly proxy?: ProxyInstallation;
  /** Whether the running rigd serves the dashboard where a rigd started now would. */
  servesDashboardAsAsked(serving: ServingDaemon | undefined): Promise<boolean>;
}

/** `daemon.start: boot` (ADR 0014, #287): rigd and its Caddy as system jobs that run as the user from boot. Defining them
 * needs the owner's sudo once, which this prints as one gated line per job (DAEMON_SYSTEM_INSTALL); everything else,
 * upgrades included, needs none, because launchd starts each program again from the same path when it exits. `prior` is
 * what ran when the install began. */
export async function installSystemDaemon(
  install: SystemInstall,
  prior: DaemonStatus,
  serving: ServingDaemon | undefined,
  proxyMode: ProxyMode | undefined,
): Promise<DaemonStatus> {
  const { root } = install;
  // Run with sudo, the jobs would be defined for root.
  if (process.getuid?.() === 0)
    throw new RigError(
      "DAEMON_SYSTEM_INSTALL",
      "rigd install must not run as root.",
      "Run rigd install as the user the jobs should run as; it prints the sudo lines it needs.",
    );
  const recorded = prior.installed
    ? await readInstallation(root).catch(() => undefined)
    : undefined;
  const userName = () => install.userName ?? userInfo().username;
  const jobs = await stageSystemJobs(install, userName, proxyMode);
  const pending: SystemJob[] = [];
  for (const job of jobs)
    if (!(await systemJobInstalled(job, install))) pending.push(job);
  // A system Caddy left from a proxy section since removed would keep the ports; only root can remove it.
  const caddyLabel = caddyJobLabel(root);
  const staleCaddy =
    proxyMode !== "managed" &&
    (await systemLeftovers(root, install.places)).includes(caddyLabel);
  if (pending.length || staleCaddy) {
    // A daemon that runs keeps its credential; with none running, a fresh one is ready for the system rigd.
    if (!prior.running) await issueToken(root);
    // Caddy needs a generation before launchd first starts it; a rigd already publishing through it has one.
    if (
      proxyMode === "managed" &&
      !(prior.reachable && recorded?.proxy === "managed")
    )
      await install.proxy!.stage();
    // The record keeps naming the rigd that runs now until both jobs are installed: a line never pasted must not leave a
    // LaunchAgent rigd recorded as a system job. The system rigd learns its mode from its plist (RIG_DAEMON_MODE).
    await writeInstallation(
      root,
      installationRecord({
        mode: recorded?.mode === "system" ? "system" : install.loginMode,
        command: install.command,
        version: RIG_BUILD,
        bun: install.bun,
        proxy: proxyMode,
      }),
    );
    // Created by the user, so launchd appends to files the user owns.
    for (const log of [
      join(root, "daemon", "startup.log"),
      join(root, "caddy", "launchd.log"),
    ]) {
      await appendPrivateFile(root, log, "");
    }
    throw systemInstallRequired({
      pending,
      ...(staleCaddy ? { staleCaddy: caddyLabel } : {}),
      userName: userName(),
      places: install.places,
    });
  }
  // Both jobs are installed and loaded, so launchd runs them; bringing them up to date needs no root.
  const current =
    prior.reachable &&
    recorded !== undefined &&
    recordedAsWanted(recorded, {
      mode: "system",
      command: install.command,
      version: RIG_BUILD,
      bun: install.bun,
      proxy: proxyMode,
    }) &&
    serving?.version === RIG_BUILD &&
    (await install.servesDashboardAsAsked(serving));
  // Before anything is recorded: a rigd that cannot stop safely keeps serving as it was installed.
  if (!current && prior.reachable && serving) await prepareStop(root);
  await writeInstallation(
    root,
    installationRecord({
      mode: "system",
      command: install.command,
      version: RIG_BUILD,
      bun: install.bun,
      proxy: proxyMode,
    }),
  );
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
    await awaitSystemDaemon(root, serving?.pid);
  }
  if (proxyMode === "managed") {
    const address = await readDaemonAddress(root);
    const client = new DaemonClient({
      port: address!.port,
      token: await readDaemonToken(root),
    });
    await install.proxy!.installPublishedBy(() =>
      client.command({ action: "proxy-apply" }),
    );
  }
  const { status } = await observeDaemon(root);
  const allWarnings = [
    ...(status.warnings ?? []),
    ...unstableProgramWarning(root, install.command),
  ];
  return {
    ...status,
    outcome: current ? "unchanged" : "installed",
    ...(replaced ? { replaced } : {}),
    ...(allWarnings.length ? { warnings: allWarnings } : {}),
  };
}
/** An upgrade needs no sudo only while the job's program stays at one path: `<root>/bin/rigd`. */
export function unstableProgramWarning(
  root: string,
  command: readonly string[],
): string[] {
  const stable = join(root, "bin", "rigd");
  return command[0] !== stable
    ? [
        `The rigd system job runs ${command[0]}, not ${stable}; installing a rigd from another path asks for sudo again.`,
      ]
    : [];
}
/** The environment of the rigd system job. It is fixed rather than copied from the installing shell, whose PATH changes
 * from one shell to the next: a root-owned plist that differed on every install would ask for sudo every time. */
export function systemEnvironment(job: {
  root: string;
  userHome: string;
  userName: string;
}): Record<string, string> {
  const home = job.userHome;
  return {
    HOME: home,
    USER: job.userName,
    LOGNAME: job.userName,
    LANG: "en_US.UTF-8",
    PATH: [
      join(job.root, "bin"),
      join(home, ".bun", "bin"),
      join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    RIG_ROOT: job.root,
    RIG_DAEMON_CHILD: "1",
    // The record names the mode only once both jobs are installed; launchd's rigd knows its own from here.
    RIG_DAEMON_MODE: "system",
  };
}
/** The plist of the rigd system job: always kept alive, run as `userName` in group staff. */
export function rigdSystemPlist(job: {
  root: string;
  command: readonly string[];
  userHome: string;
  userName: string;
}): string {
  return renderLaunchdPlist({
    label: rigdJobLabel(job.root),
    programArguments: job.command,
    environment: systemEnvironment(job),
    workingDirectory: job.root,
    log: join(job.root, "daemon", "startup.log"),
    keepAlive: "always",
    userName: job.userName,
    groupName: "staff",
  });
}
/** The system jobs Host config asks for, Caddy first: each replaces the LaunchAgent of the same label, removed only once its
 * system plist is verified. Their plists are rendered under the Rig root, where the printed sudo line copies them from. */
async function stageSystemJobs(
  install: SystemInstall,
  userName: () => string,
  proxyMode: ProxyMode | undefined,
): Promise<SystemJob[]> {
  const { root } = install;
  const rendered = join(root, "daemon", "launchd");
  await privateDirectory(root, rendered);
  const agents = join(install.userHome, "Library", "LaunchAgents");
  const domain = `gui/${install.uid ?? process.getuid?.() ?? 501}`;
  const jobs: { label: string; plist: string }[] = [];
  if (proxyMode === "managed") jobs.push(install.proxy!.systemJob());
  jobs.push({
    label: rigdJobLabel(root),
    plist: rigdSystemPlist({
      root,
      command: install.command,
      userHome: install.userHome,
      userName: userName(),
    }),
  });
  const result: SystemJob[] = [];
  for (const job of jobs) {
    const source = join(rendered, `${job.label}.plist`);
    await replacePrivateFile(root, source, job.plist, {
      mode: 0o644,
    });
    result.push({
      ...job,
      source,
      replaces: { domain, plist: join(agents, `${job.label}.plist`) },
    });
  }
  return result;
}
/** A system job is installed when /Library/LaunchDaemons holds exactly the plist this Rig renders and launchd has it. */
async function systemJobInstalled(
  job: SystemJob,
  install: Pick<SystemInstall, "places" | "launchctl">,
): Promise<boolean> {
  const installed = await readFile(
    join(install.places.daemons, `${job.label}.plist`),
    "utf8",
  ).catch(() => undefined);
  if (installed !== job.plist) return false;
  const result = await install
    .launchctl(["print", `system/${job.label}`])
    .catch(() => ({ code: 1, stderr: "" }));
  return result.code === 0;
}
/** Waits for launchd's rigd: a reachable daemon that is not `previous`. The 30 s include launchd's 10 s throttle. */
async function awaitSystemDaemon(
  root: string,
  previous: number | undefined,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { status, serving } = await observeDaemon(root);
    if (status.reachable && serving && serving.pid !== previous) return;
    const startup = await readStartupFailure(root);
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
    `Inspect ${join(root, "daemon", "startup.log")} and launchctl print system/${rigdJobLabel(root)}, then retry rigd install.`,
    { log: join(root, "daemon", "startup.log") },
  );
}
/** The labels of `root`'s system jobs whose plists are still installed. */
export async function systemLeftovers(
  root: string,
  places: SystemPlaces,
): Promise<string[]> {
  const labels = [rigdJobLabel(root), caddyJobLabel(root)];
  const present: string[] = [];
  for (const label of labels)
    if (
      await access(join(places.daemons, `${label}.plist`)).then(
        () => true,
        () => false,
      )
    )
      present.push(label);
  return present;
}
/** The jobs a boot install still needs installed by the owner's sudo, and a stale system Caddy to remove first, as one
 * error carrying a gated line for each. */
export function systemInstallRequired(needed: {
  pending: readonly SystemJob[];
  staleCaddy?: string;
  userName: string;
  places: SystemPlaces;
}): RigError {
  const { pending, staleCaddy, places } = needed;
  const lines = [
    ...(staleCaddy ? [systemRemoveLine(staleCaddy, places)] : []),
    ...pending.map((job) => systemInstallLine(job, places)),
  ];
  return new RigError(
    "DAEMON_SYSTEM_INSTALL",
    pending.length
      ? `${pending.map((job) => job.label).join(" and ")} must be installed as system ${pending.length === 1 ? "job" : "jobs"} that run as ${needed.userName} from boot, which needs sudo once.`
      : `Rig's Caddy is still installed as the system job ${staleCaddy}, but Host config has no proxy section.`,
    `Paste ${lines.length === 1 ? "this line" : "each of these lines"} in a terminal, then run rigd install again. Each line stops at the first failure, and checks a plist's digest before anything is installed:\n${lines.join("\n")}`,
    { commands: lines },
  );
}
/** Back to a LaunchAgent: the system jobs `labels` go first, or two rigd would run for one root. */
export function systemJobsRemain(
  labels: readonly string[],
  places: SystemPlaces,
): RigError {
  return new RigError(
    "DAEMON_SYSTEM_INSTALL",
    `rigd is still installed as a system job (${labels.join(", ")}), but Host config asks for daemon.start: login.`,
    `Paste ${labels.length === 1 ? "this line" : "each of these lines"} in a terminal, then run rigd install again:\n${labels.map((label) => systemRemoveLine(label, places)).join("\n")}`,
    { labels },
  );
}
/** Removing system jobs needs the owner's sudo: the error carries one gated line per job. */
export function systemRemovalRequired(
  labels: readonly string[],
  places: SystemPlaces,
): RigError {
  const lines = labels.map((label) => systemRemoveLine(label, places));
  return new RigError(
    "DAEMON_SYSTEM_UNINSTALL",
    `${labels.join(" and ")} ${labels.length === 1 ? "is a system job" : "are system jobs"}, which only root can remove.`,
    `Removing rigd's job stops rigd, so stop every Target first (rig down). Then paste ${lines.length === 1 ? "this line" : "each of these lines"} in a terminal, and run the same rigd command again:\n${lines.join("\n")}`,
    { commands: lines },
  );
}
