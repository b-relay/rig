import { createAdminActivityJournal } from "../adapters/admin-activity";
import {
  ALERT_MONITOR,
  createNoticeBoard,
  recordingDiagnostic,
  startFailureMonitor,
} from "./notices";
import {
  ALERT_EVALUATION_INTERVAL_MS,
  ALERT_OBSERVATION_BUDGET_MS,
  evaluateOperatorAlerts,
} from "../runtime/alert-monitor";
import { alertChannels } from "./alert-channels";
import type { DaemonHostOptions } from "./host";
import { inspectHost } from "../adapters/host-inspection";
import { inspectHostProxy } from "../adapters/proxy-publication";
import { randomUUID, createHash } from "node:crypto";
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
import {
  createLaunchdSupervisor,
  createLaunchdTiming,
} from "../providers/launchd-supervisor";
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
/** Composition root selects adapters. Runtime and command code see capability Interfaces only.
 * `toolBun` is the bun `rigd install` recorded for Tools whose bin is a source file; undefined when it found none.
 * `rigd` is the launcher plans name as `${rig.rigd}`, for a Service's command to run a Service helper with. */
export async function composeDaemon(
  root: string,
  captureCommand: readonly string[],
  toolBun: string | undefined,
  /** How rigd was installed: `process` under RIG_ROOT for tests and agent runs, `launchd` as the user's LaunchAgent. */
  mode: "process" | "launchd",
  rigd: string,
): Promise<Omit<DaemonHostOptions, "root" | "port">> {
  const host = await readHostConfig(root);
  const diagnostic = createFileDiagnosticLog({
    root,
    source: "rigd",
    now: () => new Date(),
    ...host.diagnostics,
  });
  // The daemon owns the platform clock, command runner, and signal path; every supervisor receives them explicitly.
  const processInspection = createProcessInspection({
    run: runCommand,
    kill: platformKill,
  });
  const child = createChildSupervisor({
    stateRoot: root,
    captureCommand,
    timing: createProcessTiming(),
    processInspection,
  });
  const uid = process.getuid?.() ?? 501;
  const launchd = createLaunchdSupervisor({
    root: join(root, "launchd"),
    domain: `gui/${uid}`,
    labelPrefix: `com.b-relay.rig.${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
    captureCommand,
    run: runCommand,
    inspect: processInspection.identity,
    groupExists: processInspection.groupExists,
    timing: createLaunchdTiming(),
  });
  const supervisors = new Map<string, Supervisor>([
    ["rigd", child],
    ["child", child],
    ["launchd", launchd],
  ]);
  const environment = inheritedEnvironment(process.env);
  const effects = createTargetEffects({
    recordingTime: () => new Date().toISOString(),
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
  const runtime = createRuntime({
    root,
    notices: notices.list,
    readAdminActivity: adminActivity.read,
    inspectHost: () => inspectHost(root),
    inspectProxy: () => inspectHostProxy(root, host, environment),
    store,
    documents: createProjectDocuments(
      root,
      runCommand,
      environment,
      homedir(),
      rigd,
    ),
    sources: createDeploymentSources(
      createGitSourceStore({ root: join(root, "sources"), run: runCommand }),
      runCommand,
    ),
    lifecycle: createTargetLifecycle(effects),
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
  const channels = alertChannels(host.alerts, mode, runCommand);
  let stopped = false;
  let stopMonitor: (() => Promise<void>) | undefined;
  let stopAlerts: (() => Promise<void>) | undefined;
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
      // Operator alerts read what the passes record and observe as status does, beside the mutation queue, never in it.
      stopAlerts = startFailureMonitor({
        intervalMs: ALERT_EVALUATION_INTERVAL_MS,
        notices,
        channel: ALERT_MONITOR,
        run: () =>
          evaluateOperatorAlerts({
            store,
            observations: effects.observations,
            observationBudgetMs: ALERT_OBSERVATION_BUDGET_MS,
            observationDeadline: timerObservationDeadline,
            inspectProxy: () => inspectHostProxy(root, host, environment),
            channels,
            now: () => new Date().toISOString(),
            id: randomUUID,
            diagnostic: recordingDiagnostic(diagnostic, notices),
            mutations: runtime.mutations,
          }),
      });
    },
    async shutdown() {
      stopped = true;
      stopMonitor?.();
      // An alert evaluation in flight finishes and saves what it delivered, so the next rigd does not deliver it again.
      await stopAlerts?.();
      await runtime.drain();
      // A clean daemon stop is not a Target stop: children keep serving and the next daemon adopts them by lease.
      await child.detach();
      await launchd.detach();
    },
  };
}
