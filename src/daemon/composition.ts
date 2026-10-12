import { createAdminActivityJournal } from "../adapters/admin-activity";
import { readProxySettings } from "../adapters/proxy-settings";
import {
  HEALTH_MONITOR,
  JOB_SCHEDULER,
  createNoticeBoard,
  recordingDiagnostic,
  startFailureMonitor,
} from "./notices";
import {
  HEALTH_MONITOR_TICK_MS,
  createHealthMonitor,
  type HealthMonitor,
} from "../runtime/health-monitor";
import type { DaemonHostOptions } from "./host";
import {
  JOB_SCHEDULER_TICK_MS,
  createJobScheduler,
} from "../runtime/job-scheduler";
import { hostTimeZone } from "../domain/cron";
import { inspectHost } from "../adapters/host-inspection";
import {
  inspectHostProxy,
  routeFileInRoot,
} from "../adapters/proxy-publication";
import { randomUUID } from "node:crypto";
import { executionBaseline, inheritedEnvironment } from "./environment";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  readHostConfig,
  readProjectConfigSource,
  previewProjectConfig,
  editProjectConfig,
} from "../config";
import { createConfigEditor } from "./config-editor";
import { createEnvEditor } from "./env-editor";
import { recordActivity } from "../domain/activity";
import { FileStateStore } from "../runtime/state-store";
import { createRuntime } from "../runtime/application";
import { createTargetLifecycle } from "../runtime/lifecycle";
import { createChildSupervisor } from "../providers/child-supervisor";
import { timerObservationDeadline } from "../runtime/bounded-observations";
/** The DNS providers `proxy.tls.dns` may name, each made from its token for one request (ADR 0018). */
const DNS_PROVIDERS: Readonly<
  Record<
    string,
    (token: string) => import("../providers/contracts").DnsProvider
  >
> = {
  cloudflare: (token) => createCloudflareDns({ token }),
};
/** One read-only observation pass (status, doctor) may take this long before components report unknown. */
const OBSERVATION_BUDGET_MS = 2000;
import {
  createProcessInspection,
  platformKill,
} from "../providers/process-inspection";
import { createProcessTiming } from "../providers/process-timing";
import { createGitSourceStore } from "../providers/git-source-store";
import { createArtifactInstaller } from "../providers/artifact-installer";
import { createCaddyRouter } from "../providers/caddy-router";
import { createCaddyAdmin } from "../providers/caddy-admin";
import { createCaddyJob } from "../providers/caddy-job";
import type { DaemonMode } from "./installation";
import {
  createManagedCaddy,
  type ManagedCaddy,
} from "../providers/managed-caddy";
import { proxyPaths } from "../domain/managed-proxy";
import { proxyReport } from "../adapters/proxy-report";
import { createDnsControl } from "../adapters/dns-control";
import { readDnsToken } from "../adapters/dns-token";
import { createCloudflareDns } from "../providers/cloudflare-dns";
import { createTailscaleAddress } from "../providers/tailscale-address";
import type { ProxyControl } from "../runtime/contracts";
import { RigError } from "../domain/errors";
import { runCommand } from "../providers/command-runner";
import { createListenerInspection } from "../providers/listener-inspection";
import { probeLocalPort } from "../providers/port-probe";
import { createHostSessionProbe } from "../providers/host-session";
import { bootOnly, type HostSessionProbe } from "../domain/host-session";
import { createProjectDocuments } from "../adapters/project-documents";
import { createDeploymentSources } from "../adapters/deployment-sources";
import { createRuntimeFiles } from "../adapters/runtime-files";
import { createBackupStorage } from "../adapters/backup-storage";
import { createTargetEffects } from "../adapters/target-effects";
import { createFileDiagnosticLog } from "../diagnostics/file-log";
import type { Supervisor } from "../providers/contracts";
import {
  hostLogRetention,
  LOG_RETENTION_REFRESH_MS,
} from "../domain/log-retention";
/** The Host session probe a daemon started in `mode` reads with. A detached process (`process`, under RIG_ROOT) outlives a
 * logout and login, and so do its children, so only a reboot is a Host restart for it: it reads only the boot. A launchd
 * job in the user's GUI login reads the login too. A system job (`daemon.start: boot`) runs from boot whether or not anyone
 * logs in, so it too reads only the boot. */
export function daemonHostSession(
  mode: DaemonMode,
  options: Parameters<typeof createHostSessionProbe>[0],
): HostSessionProbe {
  const probe = createHostSessionProbe(options);
  return mode === "launchd" ? probe : bootOnly(probe);
}
/** Composition root selects adapters. Runtime and command code see capability Interfaces only.
 * `toolBun` is the bun `rigd install` recorded for Tools whose bin is a source file; undefined when it found none. */
export async function composeDaemon(
  root: string,
  captureCommand: readonly string[],
  toolBun: string | undefined,
  /** How rigd was started (its installation record): a launchd job in the user's GUI login, a system job, or a detached
   * process. */
  mode: DaemonMode = "launchd",
): Promise<Omit<DaemonHostOptions, "root" | "port">> {
  const host = await readHostConfig(root);
  const diagnostic = createFileDiagnosticLog({
    root,
    source: "rigd",
    now: () => new Date(),
    ...host.diagnostics,
  });
  /** Aborted as the runtime begins to drain for shutdown: the stop a supervisor makes on its own (of what a start that never
   * reported left behind) stops waiting then, instead of holding the drain for the Service's whole grace. */
  const shuttingDown = new AbortController();
  // The daemon owns the platform clock, command runner, and signal path; every supervisor receives them explicitly.
  const processInspection = createProcessInspection({
    run: runCommand,
    kill: platformKill,
  });
  // Writers read the Host's logs settings as they are now, so a change needs no daemon restart.
  const logRetention = hostLogRetention({
    read: () => readHostConfig(root),
    now: Date.now,
    refreshMs: LOG_RETENTION_REFRESH_MS,
  });
  const child = createChildSupervisor({
    stateRoot: root,
    captureCommand,
    timing: createProcessTiming(),
    processInspection,
    logRetention,
    configRoot: root,
    shutdown: shuttingDown.signal,
  });
  const uid = process.getuid?.() ?? 501;
  const supervisors = new Map<string, Supervisor>([
    ["rigd", child],
    ["child", child],
  ]);
  const environment = inheritedEnvironment(process.env);
  // A written proxy section makes routes go to Rig's own Caddy (ADR 0014); rigd install set it up before rigd started.
  const managed =
    host.proxyMode === "managed" ? composeManagedCaddy(root, mode) : undefined;
  // Otherwise the route file is published for a Caddy Rig does not run (providers.caddy, retiring).
  const external = managed
    ? undefined
    : createCaddyRouter({
        caddyfile:
          host.providers.caddy.caddyfile ?? join(root, "proxy", "Caddyfile"),
        run: runCommand,
        reload: host.providers.caddy.reload.mode === "command",
        extraConfig: host.providers.caddy.extra_config,
        hostCaddyfile: async () => {
          const publication = await inspectHostProxy(root, host, environment);
          return publication.state === "imported"
            ? publication.hostCaddyfile
            : undefined;
        },
        ...(host.providers.caddy.reload.command
          ? {
              reloadCommand: [
                "/bin/sh",
                "-c",
                host.providers.caddy.reload.command,
              ],
            }
          : {}),
      });
  const store = new FileStateStore(root);
  const recordedTargets = async () =>
    new Set((await store.read()).targets.map((target) => target.id));
  const effects = createTargetEffects({
    // A Tool whose owner Target state no longer records is released to the next Target that publishes there (#343).
    recordedTargets,
    // Rig's own Tools are identified by the history of the Project's registered repository (ADR 0019).
    projectRepository: async (projectId) =>
      (await store.read()).projects.find((project) => project.id === projectId)
        ?.repoPath,
    recordingTime: () => new Date().toISOString(),
    logRetention,
    root,
    supervisors,
    run: runCommand,
    connect: probeLocalPort,
    listeners: createListenerInspection(runCommand),
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: toolBun,
    }),
    router: managed?.caddy.router ?? external!,
    environment: executionBaseline(process.env),
  });
  const notices = createNoticeBoard(() => new Date().toISOString());
  const adminActivity = createAdminActivityJournal({
    root,
    now: () => new Date().toISOString(),
    id: randomUUID,
  });
  // Built after the runtime, which restarts what it finds unhealthy; the runtime reads its results for status and doctor.
  let health: HealthMonitor | undefined;
  // A start check that passed is the healthcheck's first passing check, so status shows it at once.
  // Every start and stop tells the health monitor as it begins, and a passed start check is its first passing check.
  const lifecycle = createTargetLifecycle(effects, undefined, {
    changing: (target, service) => health?.invalidate(target.id, service),
    activated: (target, service, incarnation) =>
      health?.started(target, service, incarnation),
  });
  const runtime = createRuntime({
    root,
    // Nothing starts until the first pass has read the state, however early a command arrives.
    reconcileGate: "closed",
    healthResults: (target, service) => health?.results(target, service),
    notices: notices.list,
    readAdminActivity: adminActivity.read,
    inspectHost: () => inspectHost(root),
    inspectProxy: () => inspectHostProxy(root, host, environment),
    routeFileInRoot: () => routeFileInRoot(root, host),
    orphanedTools: (recorded) => effects.orphanedTools(recorded),
    ...(managed ? { proxy: managed.control } : {}),
    // Host config and the token are read at every request, so DNS needs no restart after rig proxy token or an edit.
    dns: createDnsControl({
      settings: async () => (await readHostConfig(root)).proxy,
      token: () => readDnsToken(root),
      provider: (name, token) => {
        const create = DNS_PROVIDERS[name];
        if (!create)
          throw new RigError(
            "DNS_UNCONFIGURED",
            `Rig has no DNS provider named ${name}.`,
            `Set proxy.tls.dns to one of: ${Object.keys(DNS_PROVIDERS).join(", ")}.`,
          );
        return create(token);
      },
      address: createTailscaleAddress({ run: runCommand }),
    }),
    store,
    documents: createProjectDocuments(root, runCommand, environment, homedir()),
    sources: createDeploymentSources(
      createGitSourceStore({ root: join(root, "sources"), run: runCommand }),
      runCommand,
    ),
    lifecycle,
    timeZone: hostTimeZone,
    healthTransitions: {
      invalidate: (targetId, service) => health?.invalidate(targetId, service),
    },
    observations: effects.observations,
    observationBudgetMs: OBSERVATION_BUDGET_MS,
    observationDeadline: timerObservationDeadline,
    // A pass hands slow work (a restart waiting for readiness, a stop waiting for an exit) to its Target's lease and returns,
    // so the next pass still reaches every other Target on time.
    supervisionPassBudget: {
      ms: OBSERVATION_BUDGET_MS,
      deadline: timerObservationDeadline,
    },
    files: createRuntimeFiles(),
    backups: createBackupStorage(root),
    // The boot and GUI login rigd's first pass compares with the last recorded, to start Stable Targets after a restart.
    hostSession: daemonHostSession(mode, { run: runCommand, uid }),
    now: () => new Date().toISOString(),
    id: randomUUID,
    diagnostic: recordingDiagnostic(diagnostic, notices),
  });
  health = createHealthMonitor({
    store,
    observations: effects.observations,
    now: () => Date.now(),
    id: randomUUID,
    busy: runtime.targetBusy,
    restart: runtime.restartUnhealthy,
    schedule(delayMs, fire) {
      const timer = setTimeout(fire, delayMs);
      return () => clearTimeout(timer);
    },
    diagnostic: recordingDiagnostic(diagnostic, notices),
  });
  const monitor = health;
  // Scheduled job runs start, end and stop as Operations on their Target; the scheduler itself only reads state and
  // observes runs.
  const jobs = createJobScheduler({
    store,
    lifecycle,
    clock: { now: () => Date.now(), timeZone: hostTimeZone },
    id: randomUUID,
    busy: runtime.targetBusy,
    start: runtime.runScheduledJob,
    settle: runtime.settleJob,
    releaseCheckouts: runtime.releaseHeldCheckouts,
    stopJobsIfOff: runtime.stopJobsIfOff,
    tidyBackups: runtime.tidyBackups,
    diagnostic: recordingDiagnostic(diagnostic, notices),
  });
  const editor = createConfigEditor({
    async resolveProject(name) {
      return (await store.read()).projects.find(
        (project) => project.name === name,
      );
    },
    documents: {
      read: readProjectConfigSource,
      preview: previewProjectConfig,
      apply: editProjectConfig,
    },
    exclusive: runtime.exclusive,
  });
  const env = createEnvEditor({
    envRoot: join(root, "env"),
    async resolveProject(name) {
      return (await store.read()).projects.find(
        (project) => project.name === name,
      );
    },
    async services(repoPath) {
      const source = await readProjectConfigSource(repoPath);
      return Object.keys(source.config.services ?? {}).sort();
    },
    exclusive: runtime.exclusive,
    async record(operation) {
      await store.update((state) => recordActivity(state, operation));
    },
    now: () => new Date().toISOString(),
    id: randomUUID,
  });
  let stopped = false;
  let stopMonitor: (() => Promise<void>) | undefined;
  let stopHealth: (() => Promise<void>) | undefined;
  let stopJobs: (() => Promise<void>) | undefined;
  return {
    handle: runtime.command,
    editor,
    env,
    async start() {
      // Queued ahead of anything the first pass publishes: Host config's proxy settings (or extra_config) may have changed, and a
      // crash may have left the route file ahead of the current generation. A failure is a doctor finding, not a failed start.
      void (managed ? managed.caddy.republish() : external!.republish()).catch(
        (error: unknown) =>
          diagnostic.record({
            event: "proxy.republish",
            level: "error",
            ...(error instanceof RigError ? { code: error.code } : {}),
            ...(error instanceof RigError &&
            typeof error.details?.evidence === "string"
              ? { evidence: error.details.evidence }
              : {}),
          }),
      );
      await runtime.reconcile();
      // Queued behind the republish, beside everything else: a route block no recorded Target owns (one an earlier rig
      // forget left, #336) is withdrawn so its hostnames can be published again, unless the route file lies outside the
      // Rig root. A failure is recorded, and doctor names the blocks.
      void runtime.withdrawOrphanedRoutes();
      if (stopped) return;
      // Restart policy is applied here, never by a supervisor: every pass records exits and makes the attempts that are due.
      stopMonitor = startFailureMonitor({
        intervalMs: 1000,
        notices,
        run: () => runtime.supervise(),
      });
      // Ongoing checks run beside the operation queue; a restart they ask for waits for its Target like any command.
      stopHealth = startFailureMonitor({
        intervalMs: HEALTH_MONITOR_TICK_MS,
        notices,
        channel: HEALTH_MONITOR,
        run: () => monitor.pass(),
      });
      // Scheduled jobs start beside the operation queue's other work, each start waiting for its Target like a command.
      stopJobs = startFailureMonitor({
        intervalMs: JOB_SCHEDULER_TICK_MS,
        notices,
        channel: JOB_SCHEDULER,
        run: () => jobs.pass(),
      });
    },
    async shutdown() {
      stopped = true;
      stopMonitor?.();
      await stopHealth?.();
      // No new run starts from here on; a run in progress keeps running under its capture wrapper, and the next rigd
      // adopts it by lease and records how it ends.
      await stopJobs?.();
      const scheduler = jobs.stop();
      // The monitor writes nothing from here on; its probes are aborted (a command's process group killed) and waited for
      // within a bound, beside the drain, which detaches the stop of any health restart in flight.
      const health = monitor.stop();
      // With the runtime's own stops, which its drain detaches as it begins.
      shuttingDown.abort();
      await runtime.drain();
      await health;
      await scheduler;
      // A clean daemon stop is not a Target stop: children keep serving and the next daemon adopts them by lease.
      await child.detach();
    },
  };
}
/** Rig's own Caddy as rigd drives it: publication through generations, and the job only observed and restarted, never
 * installed; `rigd install` installs it. The proxy settings are read at every publication, so `rig proxy reload` applies an
 * edit to them. */
function composeManagedCaddy(
  root: string,
  mode: DaemonMode,
): { caddy: ManagedCaddy; control: ProxyControl } {
  const paths = proxyPaths(root);
  const admin = createCaddyAdmin(paths.socket);
  const job = createCaddyJob({
    root,
    paths,
    mode,
    userHome: homedir(),
    uid: process.getuid?.() ?? 501,
    userName: userInfo().username,
    admin,
  });
  const settings = () => readProxySettings(root);
  const caddy = createManagedCaddy({
    root,
    settings,
    run: runCommand,
    job,
    admin,
  });
  return {
    caddy,
    control: {
      report: async (targets) =>
        proxyReport({
          root,
          requested: await settings().catch((error: unknown) =>
            error instanceof Error ? error : new Error(String(error)),
          ),
          job,
          admin,
          targets,
        }),
      apply: async () => {
        await caddy.republish();
      },
    },
  };
}
