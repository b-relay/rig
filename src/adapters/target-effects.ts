import type { TargetRecord } from "../domain/runtime";
import type { Supervisor, CommandRunner } from "../providers/contracts";
import type { ArtifactInstaller } from "../providers/artifact-installer";
import type { Router } from "../providers/caddy-router";
import type { ListenerInspection } from "../providers/listener-inspection";
import type { PortProbe } from "../providers/port-probe";
import { declaredPorts } from "../runtime/ports";
import type { TargetEffects } from "../runtime/lifecycle";
import type { ObservationEffects } from "../runtime/status";
import { RigError } from "../domain/errors";
import { rigCommand } from "../domain/rig-command";
import { installedPath } from "../domain/installed-path";
import {
  createArtifactOwnership,
  type OrphanedArtifact,
} from "./artifact-ownership";
import { rememberedDigests } from "./file-digest";
import { createEffectTransactions } from "./effect-transactions";
import { createEnvironmentDigest } from "./environment-digest";
import type { LogRetention } from "../domain/log-retention";
import { createTargetOutput } from "./target-output";
import { createInvocationEnvironment } from "./invocation-environment";
import { createTargetCommand } from "./target-commands";
import { createTargetHealth } from "./target-health";
import { createTargetArtifacts } from "./target-artifacts";
import { createToolPublication } from "./tool-publication";
import { createTargetRoutes } from "./target-routes";
import { createTargetPreparation } from "./target-preparation";
import { exists } from "./path-exists";

export interface TargetAdapterOptions {
  root: string;
  /** Acquires an ISO timestamp per recorded output entry, after buffered execution. */
  recordingTime: () => string;
  supervisors: ReadonlyMap<string, Supervisor>;
  run: CommandRunner;
  installer: ArtifactInstaller;
  router: Router;
  /** Asks whether a declared port accepts connections; `probeLocalPort` on the platform. */
  connect: PortProbe;
  listeners: ListenerInspection;
  environment: Readonly<Record<string, string>>;
  /** Reads how the Target log is rotated each time build, install and health lines are recorded; the default when absent. */
  logRetention?: () => Promise<LogRetention>;
  /** The Target ids state records now. A Tool whose owner it does not name is released: the next Target that publishes
   * there takes it over while its bytes are the ones Rig published (#343). Absent: no Tool is ever taken over. */
  recordedTargets?: () => Promise<ReadonlySet<string>>;
  /** The Project and Target names state records now for a Target id, so an ownership conflict names the owner as it is
   * registered after a rename (#590). Absent: the names its ownership record kept. */
  currentNames?: (
    targetId: string,
  ) => Promise<{ project: string; target: string } | undefined>;
  /** The registered repository path of Project `projectId`, read from state now, or undefined when it is not registered.
   * Rig's own Tools are identified by that repository's history (ADR 0019). Absent: no repository is ever identified. */
  projectRepository?: (projectId: string) => Promise<string | undefined>;
}
export { installedPath };
/** Owns target-specific filesystem and process effects, composed from one owner each: invocation environments, command
 * runs and their output, health checks, workspace preparation and builds, Tool publication, artifacts and routes.
 * Orchestration policy lives in lifecycle. */
export function createTargetEffects(
  options: TargetAdapterOptions,
): TargetEffects & {
  observations: ObservationEffects;
  /** Every Tool in `<root>/bin` whose owner Target `recorded` does not name; see `OrphanedArtifact`. */
  orphanedTools(
    recorded: () => Promise<ReadonlySet<string>>,
  ): Promise<OrphanedArtifact[]>;
} {
  // Status hashes every installed Tool inside one short budget; remembering digests keeps that under it.
  const digestFile = rememberedDigests();
  const ownership = createArtifactOwnership(
    options.root,
    digestFile,
    options.recordedTargets,
    options.currentNames,
  );
  const transactions = createEffectTransactions({
    root: options.root,
    ownership,
    router: options.router,
  });
  const supervisor = (target: TargetRecord) => {
    const provider = options.supervisors.get(
      target.plan.providers.processSupervisor,
    );
    if (!provider)
      throw new RigError(
        "PROVIDER_MISSING",
        `Process supervisor '${target.plan.providers.processSupervisor}' is unavailable.`,
        `This rigd supervises with ${[...options.supervisors.keys()].join(", ")}. Plan the Target again with this rigd: ${target.kind === "working" ? rigCommand("restart", { target }) : rigCommand("deploy", { target }, "--force")}.`,
      );
    return provider;
  };
  const output = createTargetOutput({
    root: options.root,
    recordingTime: options.recordingTime,
    ...(options.logRetention ? { logRetention: options.logRetention } : {}),
  });
  const environment = createInvocationEnvironment({
    root: options.root,
    environment: options.environment,
    run: options.run,
    output,
  });
  const command = createTargetCommand({
    run: options.run,
    supervisors: options.supervisors,
    output,
  });
  const health = createTargetHealth({
    run: options.run,
    connect: options.connect,
    listeners: options.listeners,
    environment,
    output,
    supervisor,
  });
  const artifacts = createTargetArtifacts({
    root: options.root,
    run: options.run,
    environment: options.environment,
    installer: options.installer,
    digestFile,
    ownership,
    transactions,
    ...(options.projectRepository
      ? { projectRepository: options.projectRepository }
      : {}),
  });
  const digest = createEnvironmentDigest(options.root);
  return {
    supervisor,
    environment: environment.environment,
    digestEnvironment: (target, env) => digest(env, target.plan.workspacePath),
    checkEnvironmentValues: environment.checkEnvironmentValues,
    health: health.health,
    pruneCheckpoints: (live) => transactions.pruneCheckpoints(live),
    checkpoint: async (target, previous) =>
      await transactions.checkpoint(
        target.id,
        await artifacts.checkpointed(target, previous),
      ),
    commitEffects: (target) => transactions.commit(target.id),
    restoreEffects: (target) => transactions.restore(target.id),
    retireArtifacts: artifacts.retireArtifacts,
    retireSuperseded: artifacts.retireSuperseded,
    ...createTargetPreparation({
      root: options.root,
      run: options.run,
      baseline: options.environment,
      command,
      environment,
      output,
    }),
    install: createToolPublication({
      root: options.root,
      installer: options.installer,
      digestFile,
      ownership,
      transactions,
      artifacts,
      environment,
    }),
    listeners: (pid, signal) => options.listeners.inspect(pid, signal),
    ...createTargetRoutes({ router: options.router, transactions }),
    orphanedTools: (recorded) => ownership.orphans(recorded),
    observations: {
      process: (target, component, signal) =>
        supervisor(target).observe(`${target.id}:${component.name}`, signal),
      health: (target, component, signal) =>
        health.ongoingHealth(component, target, signal),
      artifact: (target, component) => artifacts.observe(target, component),
      persistent: (_target, component) => exists(component.path),
      toolRunsFrom: (target, checkout) =>
        artifacts.toolRunsFrom(target, checkout),
      async listening(_target, component, signal) {
        const ports = [
          ...new Set([
            ...Object.values(declaredPorts(component)),
            ...(component.sitePort ? [component.sitePort] : []),
          ]),
        ].sort((a, b) => a - b);
        const open: number[] = [];
        for (const port of ports)
          if ((await options.connect(port, signal)).ready) open.push(port);
        return open;
      },
    },
  };
}
