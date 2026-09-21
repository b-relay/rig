import { createAdminActivityJournal } from "../adapters/admin-activity";
import {
  createNoticeBoard,
  recordingDiagnostic,
  startFailureMonitor,
} from "./notices";
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
import { createProjectDocuments } from "../adapters/project-documents";
import { createDeploymentSources } from "../adapters/deployment-sources";
import { createRuntimeFiles } from "../adapters/runtime-files";
import { createTargetEffects } from "../adapters/target-effects";
import { createFileDiagnosticLog } from "../diagnostics/file-log";
import type { Supervisor } from "../providers/contracts";
/** Composition root selects adapters. Runtime and command code see capability Interfaces only. */
export async function composeDaemon(
  root: string,
  captureCommand: readonly string[],
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
  const launchd = createLaunchdSupervisor({
    root: join(root, "launchd"),
    domain: `gui/${process.getuid?.() ?? 501}`,
    labelPrefix: `com.b-relay.rig.${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
    captureCommand,
    run: runCommand,
    inspect: processInspection.identity,
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
      bunExecutable: process.execPath,
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
    documents: createProjectDocuments(root, runCommand, environment, homedir()),
    sources: createDeploymentSources(
      createGitSourceStore({ root: join(root, "sources"), run: runCommand }),
      runCommand,
    ),
    lifecycle: createTargetLifecycle(effects),
    observations: effects.observations,
    observationBudgetMs: OBSERVATION_BUDGET_MS,
    observationDeadline: timerObservationDeadline,
    files: createRuntimeFiles(),
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
  let stopped = false;
  let stopMonitor: (() => void) | undefined;
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
    },
    async shutdown() {
      stopped = true;
      stopMonitor?.();
      await runtime.drain();
      // A clean daemon stop is not a Target stop: children keep serving and the next daemon adopts them by lease.
      await child.detach();
      await launchd.detach();
    },
  };
}
