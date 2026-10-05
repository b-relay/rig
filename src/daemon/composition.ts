import { createAdminActivityJournal } from "../adapters/admin-activity";
import {
  HEALTH_MONITOR,
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
import { inspectHost } from "../adapters/host-inspection";
import { inspectHostProxy } from "../adapters/proxy-publication";
import { randomUUID } from "node:crypto";
import { executionBaseline, inheritedEnvironment } from "./environment";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readHostConfig,
  readProjectConfigSource,
  previewProjectConfig,
  editProjectConfig,
} from "../config";
import { createConfigEditor } from "./config-editor";
import { FileStateStore } from "../runtime/state-store";
import { createRuntime } from "../runtime/application";
import { createTargetLifecycle } from "../runtime/lifecycle";
import { createChildSupervisor } from "../providers/child-supervisor";
import { timerObservationDeadline } from "../runtime/bounded-observations";
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
import { runCommand } from "../providers/command-runner";
import { createListenerInspection } from "../providers/listener-inspection";
import { probeLocalPort } from "../providers/port-probe";
import { createHostSessionProbe } from "../providers/host-session";
import { createProjectDocuments } from "../adapters/project-documents";
import { createDeploymentSources } from "../adapters/deployment-sources";
import { createRuntimeFiles } from "../adapters/runtime-files";
import { createTargetEffects } from "../adapters/target-effects";
import { createFileDiagnosticLog } from "../diagnostics/file-log";
import type { Supervisor } from "../providers/contracts";
import {
  hostLogRetention,
  LOG_RETENTION_REFRESH_MS,
} from "../domain/log-retention";
/** Composition root selects adapters. Runtime and command code see capability Interfaces only.
 * `toolBun` is the bun `rigd install` recorded for Tools whose bin is a source file; undefined when it found none. */
export async function composeDaemon(
  root: string,
  captureCommand: readonly string[],
  toolBun: string | undefined,
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
  const effects = createTargetEffects({
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
    router: createCaddyRouter({
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
    }),
    environment: executionBaseline(process.env),
  });
  const store = new FileStateStore(root);
  const notices = createNoticeBoard(() => new Date().toISOString());
  const adminActivity = createAdminActivityJournal({
    root,
    now: () => new Date().toISOString(),
    id: randomUUID,
  });
  // Built after the runtime, which restarts what it finds unhealthy; the runtime reads its results for status and doctor.
  let health: HealthMonitor | undefined;
  const runtime = createRuntime({
    root,
    healthResults: (target, service) => health?.results(target, service),
    notices: notices.list,
    readAdminActivity: adminActivity.read,
    inspectHost: () => inspectHost(root),
    inspectProxy: () => inspectHostProxy(root, host, environment),
    store,
    documents: createProjectDocuments(root, runCommand, environment, homedir()),
    sources: createDeploymentSources(
      createGitSourceStore({ root: join(root, "sources"), run: runCommand }),
      runCommand,
    ),
    // A start check that passed is the healthcheck's first passing check, so status shows it at once.
    lifecycle: createTargetLifecycle(effects, undefined, {
      activated: (target, service, incarnation) =>
        health?.started(target, service, incarnation),
    }),
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
    // The boot and GUI login rigd's first pass compares with the last recorded, to start Stable Targets after a restart.
    hostSession: createHostSessionProbe({ run: runCommand, uid }),
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
  let stopped = false;
  let stopMonitor: (() => Promise<void>) | undefined;
  let stopHealth: (() => Promise<void>) | undefined;
  return {
    handle: runtime.command,
    editor,
    async start() {
      await runtime.reconcile();
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
    },
    async shutdown() {
      stopped = true;
      stopMonitor?.();
      await stopHealth?.();
      // With the runtime's own stops, which its drain detaches as it begins.
      shuttingDown.abort();
      await runtime.drain();
      // A clean daemon stop is not a Target stop: children keep serving and the next daemon adopts them by lease.
      await child.detach();
    },
  };
}
