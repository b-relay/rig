import { createAdminActivityJournal } from "../adapters/admin-activity";
import { monitorRuntimeFailures } from "../runtime/activity";
import type { DaemonHostOptions } from "./host";
import { inspectHost } from "../adapters/host-inspection";
import { createAdoptionGuard } from "../migration/adoption";
import { randomUUID, createHash } from "node:crypto";
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
import { createLaunchdSupervisor } from "../providers/launchd-supervisor";
import { createGitSourceStore } from "../providers/git-source-store";
import { createArtifactInstaller } from "../providers/artifact-installer";
import { createCaddyRouter } from "../providers/caddy-router";
import { runCommand } from "../providers/command-runner";
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
  const child = createChildSupervisor({ stateRoot: root, captureCommand });
  const launchd = createLaunchdSupervisor({
    root: join(root, "launchd"),
    domain: `gui/${process.getuid?.() ?? 501}`,
    labelPrefix: `com.b-relay.rig.${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
    captureCommand,
  });
  const supervisors = new Map<string, Supervisor>([
    ["rigd", child],
    ["child", child],
    ["launchd", launchd],
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const effects = createTargetEffects({
    recordingTime: () => new Date().toISOString(),
    root,
    supervisors,
    run: runCommand,
    installer: createArtifactInstaller(),
    router: createCaddyRouter({
      caddyfile:
        host.providers.caddy.caddyfile ?? join(root, "proxy", "Caddyfile"),
      reload: host.providers.caddy.reload.mode === "command",
      extraConfig: host.providers.caddy.extraConfig,
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
    environment,
  });
  const store = new FileStateStore(root);
  const adminActivity = createAdminActivityJournal({
    root,
    now: () => new Date().toISOString(),
    id: randomUUID,
  });
  const runtime = createRuntime({
    root,
    readAdminActivity: adminActivity.read,
    inspectHost: () => inspectHost(root),
    assertOwnershipReady: createAdoptionGuard(root),
    store,
    documents: createProjectDocuments(root, runCommand),
    sources: createDeploymentSources(
      createGitSourceStore({ root: join(root, "sources") }),
      runCommand,
    ),
    lifecycle: createTargetLifecycle(effects),
    observations: effects.observations,
    files: createRuntimeFiles(),
    now: () => new Date().toISOString(),
    id: randomUUID,
    async diagnostic(event) {
      await diagnostic.record({
        event: "operation.completed",
        ...event,
        code: event.errorCode,
      });
    },
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
  let stopped = false,
    monitoring = false;
  let monitor: ReturnType<typeof setInterval> | undefined;
  return {
    handle: runtime.command,
    editor,
    async start() {
      await runtime.reconcile();
      if (stopped) return;
      monitor = setInterval(() => {
        if (monitoring || stopped) return;
        monitoring = true;
        void runtime
          .exclusive(() =>
            monitorRuntimeFailures({
              store,
              observations: effects.observations,
              now: () => new Date().toISOString(),
            }),
          )
          .catch(() => {})
          .finally(() => {
            monitoring = false;
          });
      }, 5000);
    },
    async shutdown() {
      stopped = true;
      clearInterval(monitor);
      await runtime.drain();
      await child.shutdown();
      await launchd.shutdown();
    },
  };
}
